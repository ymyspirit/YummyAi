// Pure Docker-inspect to Compose projection. The model and comparable objects
// can contain credentials: callers must keep them private and log only summary.
const MEMBERS = Object.freeze({
  infra: Object.freeze({ postgres: "postgres", redis: "redis", minio: "minio", keycloak: "keycloak", clamav: "clamav", "otel-collector": "otel-collector" }),
  "sub2api-deploy": Object.freeze({ postgres: "sub2api-postgres", redis: "sub2api-redis", sub2api: "sub2api" }),
  "yummyai-canvas": Object.freeze({ canvas: "canvas-legacy" }),
});
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const fail = code => { throw new Error(`UNIFIED_COMPOSE_${code}`); };
const object = (value, code) => { if (!isObject(value)) fail(code); return value; };
const text = (value, code) => { if (typeof value !== "string" || value.includes("\0")) fail(code); return value; };
const array = (value, code) => { if (!Array.isArray(value)) fail(code); return value; };
const strings = (value, code) => array(value ?? [], code).map(item => text(item, code));
const integer = (value, code) => { if (!Number.isSafeInteger(value)) fail(code); return value; };
const present = value => value !== undefined && value !== null && value !== "" && value !== false && value !== 0 &&
  (!Array.isArray(value) || value.length > 0) && (!isObject(value) || Object.keys(value).length > 0);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
    typeof value === "number" && !Number.isFinite(value)) fail("CAPTURE_INVALID");
  return value;
}
const equal = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const unique = values => [...new Set(values)].sort();
function stringMap(value, code) {
  return Object.fromEntries(Object.entries(object(value ?? {}, code)).map(([key, entry]) => [text(key, code), text(entry, code)]));
}

function environment(value) {
  const entries = [], keys = new Set();
  for (const entry of array(value, "ENV_INVALID")) {
    text(entry, "ENV_INVALID");
    const at = entry.indexOf("="), key = entry.slice(0, at);
    if (at < 1 || keys.has(key)) fail("ENV_INVALID");
    keys.add(key); entries.push([key, entry.slice(at + 1)]);
  }
  return Object.fromEntries(entries);
}
function argv(value) { return value === undefined || value === null ? [] : strings(value, "CAPTURE_INVALID"); }
function health(value) {
  if (value === undefined || value === null) return null;
  const source = object(value, "CAPTURE_INVALID"), test = strings(source.Test, "CAPTURE_INVALID");
  if (!test.length || test[0] === "NONE") {
    if (test.length > 1) fail("CAPTURE_INVALID");
    return null;
  }
  if (!["CMD", "CMD-SHELL"].includes(test[0])) fail("CAPTURE_INVALID");
  const result = { test };
  const fields = { Interval: "interval", Timeout: "timeout", StartPeriod: "start_period", StartInterval: "start_interval" };
  for (const [key, target] of Object.entries(fields)) {
    const amount = source[key] ?? 0;
    if (integer(amount, "CAPTURE_INVALID") < 0) fail("CAPTURE_INVALID");
    if (amount) result[target] = `${amount}ns`;
  }
  const retries = source.Retries ?? 0;
  if (integer(retries, "CAPTURE_INVALID") < 0) fail("CAPTURE_INVALID");
  if (retries) result.retries = retries;
  for (const key of Object.keys(source)) if (!["Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"].includes(key) && present(source[key])) fail("UNSUPPORTED_RUNTIME");
  return result;
}

function identity(container, originalOnly = false) {
  object(container, "CAPTURE_INVALID");
  const config = object(container.Config, "CAPTURE_INVALID"), labels = stringMap(config.Labels, "CAPTURE_INVALID");
  const project = labels["com.docker.compose.project"], service = labels["com.docker.compose.service"];
  let sourceProject = project, sourceService = service, mapped;
  if (own(MEMBERS, project ?? "") && own(MEMBERS[project], service ?? "")) mapped = MEMBERS[project][service];
  else if (!originalOnly && typeof project === "string") {
    for (const [candidateProject, services] of Object.entries(MEMBERS)) {
      const entry = Object.entries(services).find(([, next]) => next === service);
      if (entry) { sourceProject = candidateProject; sourceService = entry[0]; mapped = entry[1]; break; }
    }
  }
  if (!mapped) fail("MEMBERSHIP_INVALID");
  const name = text(container.Name, "CAPTURE_INVALID").replace(/^\//, "");
  if (!NAME.test(name) || !IMAGE_ID.test(container.Image ?? "") || typeof container.Id !== "string" || !/^[a-f0-9]{64}$/.test(container.Id)) fail("CAPTURE_INVALID");
  object(container.HostConfig, "CAPTURE_INVALID");
  array(container.Mounts, "MOUNT_INVALID");
  object(container.NetworkSettings, "NETWORK_INVALID");
  environment(config.Env);
  return { config, name, sourceProject, sourceService, service: mapped, project };
}

function ports(container) {
  const bindings = object(container.HostConfig.PortBindings ?? {}, "PORT_INVALID");
  const actual = container.NetworkSettings.Ports;
  const stopped = container.State?.Running === false || ["created", "exited", "dead"].includes(container.State?.Status);
  // Stopped/created containers have no live sockets: Docker may report an
  // empty map or null entries. Preserve their fixed HostConfig intention.
  // Running containers must prove every requested binding from actual ports.
  const source = stopped ? bindings : object(actual ?? {}, "PORT_INVALID");
  const results = [], diagnostics = [], seen = new Set();
  for (const [key, values] of Object.entries(source)) {
    const match = /^(\d+)\/(tcp|udp|sctp)$/.exec(key);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) fail("PORT_INVALID");
    if (values === null) continue;
    for (const entry of array(values, "PORT_INVALID")) {
      object(entry, "PORT_INVALID");
      const published = text(entry.HostPort, "PORT_INVALID"), host = text(entry.HostIp ?? "", "PORT_INVALID");
      if (!/^\d+$/.test(published) || Number(published) < 1 || Number(published) > 65535) fail("PORT_INVALID");
      const id = `${key}|${host}|${published}`;
      if (seen.has(id)) fail("PORT_INVALID");
      seen.add(id); results.push({ target: Number(match[1]), published, protocol: match[2], ...(host ? { host_ip: host } : {}) });
    }
  }
  // A running fixed host binding must not silently disappear from the capture.
  for (const [key, values] of Object.entries(bindings)) for (const entry of array(values ?? [], "PORT_INVALID")) {
    object(entry, "PORT_INVALID");
    const effective = results.some(value => `${value.target}/${value.protocol}` === key &&
      (!entry.HostPort || entry.HostPort === "0" || value.published === entry.HostPort) &&
      (!entry.HostIp || (value.host_ip ?? "") === entry.HostIp));
    if (effective) continue;
    const labels = container.Config.Labels, configured = bindings["9000/tcp"];
    const live = results.filter(value => value.target === 9000 && value.protocol === "tcp");
    // One independently verified historical MinIO configuration contains an
    // inactive wildcard 9000 intention beside its actual loopback 19000 map.
    // Capturing that intention would reopen a port. This exact exception is
    // deliberately limited to its original owner, shape and effective map.
    const knownInactiveMinio = !stopped && container.State?.Running === true && container.Name === "/infra-minio-1" &&
      labels["com.docker.compose.project"] === "infra" && labels["com.docker.compose.service"] === "minio" &&
      key === "9000/tcp" && entry.HostIp === "" && entry.HostPort === "9000" && Array.isArray(configured) && configured.length === 2 && configured.every(isObject) &&
      configured.filter(value => value.HostIp === "" && value.HostPort === "9000").length === 1 &&
      configured.filter(value => value.HostIp === "127.0.0.1" && value.HostPort === "19000").length === 1 &&
      live.length === 1 && live[0].host_ip === "127.0.0.1" && live[0].published === "19000";
    if (!knownInactiveMinio) fail("PORT_INVALID");
    diagnostics.push({ code: "UNIFIED_COMPOSE_KNOWN_MINIO_INACTIVE_PORT_INTENT", sourceProject: "infra", service: "minio", container: "infra-minio-1",
      configured: { target: 9000, published: "9000", protocol: "tcp", host_ip: "" }, effective: live });
  }
  return { ports: results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), diagnostics };
}

function sourcePath(value) {
  const path = text(value, "MOUNT_INVALID");
  // Only Windows host paths are case insensitive. Linux paths and container
  // destinations must retain case (a different /Data is a different mount).
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path)) return path.replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
function mountOptions(container, mount) {
  const candidates = array(container.HostConfig.Mounts ?? [], "MOUNT_INVALID").filter(value => value.Target === mount.Destination);
  if (candidates.length > 1) fail("MOUNT_INVALID");
  return candidates[0] ?? {};
}
function mounts(container) {
  const targets = new Set();
  return array(container.Mounts, "MOUNT_INVALID").map(mount => {
    object(mount, "MOUNT_INVALID");
    const target = text(mount.Destination, "MOUNT_INVALID"), type = mount.Type;
    if (!target.startsWith("/") || targets.has(target) || typeof mount.RW !== "boolean" || !["bind", "volume", "tmpfs"].includes(type)) fail("MOUNT_INVALID");
    targets.add(target);
    const options = mountOptions(container, mount), mode = text(mount.Mode ?? "", "MOUNT_INVALID").split(",").filter(Boolean);
    const allowedModes = ["ro", "rw", "z", "Z", "nocopy", "cached", "delegated", "consistent", "rprivate", "private", "shared", "rshared", "slave", "rslave", "unbindable", "runbindable"];
    if (mode.some(value => !allowedModes.includes(value)) || mode.includes("ro") && mount.RW || mode.includes("rw") && !mount.RW) fail("MOUNT_INVALID");
    const result = { type, target, read_only: !mount.RW };
    const consistency = mode.find(value => ["cached", "delegated", "consistent"].includes(value));
    if (consistency) result.consistency = consistency;
    if (type === "bind") {
      result.source = text(mount.Source, "MOUNT_INVALID");
      if (!result.source) fail("MOUNT_INVALID");
      const bind = object(options.BindOptions ?? {}, "MOUNT_INVALID");
      if (bind.NonRecursive || bind.ReadOnlyNonRecursive || bind.ReadOnlyForceRecursive) fail("UNSUPPORTED_RUNTIME");
      result.bind = { create_host_path: false };
      const propagation = bind.Propagation || mount.Propagation;
      if (propagation) result.bind.propagation = text(propagation, "MOUNT_INVALID");
      const selinux = mode.find(value => value === "z" || value === "Z");
      if (selinux) result.bind.selinux = selinux;
    } else if (type === "volume") {
      if (!NAME.test(mount.Name ?? "") || !text(mount.Source, "MOUNT_INVALID")) fail("MOUNT_INVALID");
      result.source = mount.Name;
      const volume = object(options.VolumeOptions ?? {}, "MOUNT_INVALID");
      if (volume.NoCopy || mode.includes("nocopy")) result.volume = { nocopy: true };
      if (volume.Subpath) result.volume = { ...result.volume, subpath: text(volume.Subpath, "MOUNT_INVALID") };
    } else {
      const tmpfs = object(options.TmpfsOptions ?? {}, "MOUNT_INVALID");
      if (present(tmpfs.SizeBytes) || present(tmpfs.Mode)) result.tmpfs = {
        ...(present(tmpfs.SizeBytes) ? { size: integer(tmpfs.SizeBytes, "MOUNT_INVALID") } : {}),
        ...(present(tmpfs.Mode) ? { mode: integer(tmpfs.Mode, "MOUNT_INVALID") } : {}),
      };
    }
    return result;
  }).sort((a, b) => a.target.localeCompare(b.target));
}

function networks(container, member) {
  const source = object(container.NetworkSettings.Networks, "NETWORK_INVALID"), result = {};
  if (!Object.keys(source).length) fail("NETWORK_INVALID");
  const mode = container.HostConfig.NetworkMode;
  if (mode && mode !== "default" && !own(source, mode)) fail("UNSUPPORTED_RUNTIME");
  for (const [name, endpoint] of Object.entries(source)) {
    if (!NAME.test(name) || ["host", "none", "bridge"].includes(name)) fail("NETWORK_INVALID");
    object(endpoint, "NETWORK_INVALID");
    if (present(endpoint.Links)) fail("UNSUPPORTED_RUNTIME");
    const generated = new Set([container.Id, container.Id.slice(0, 12)]);
    const aliases = unique(strings(endpoint.Aliases, "NETWORK_INVALID").filter(value => !generated.has(value)));
    const ipam = object(endpoint.IPAMConfig ?? {}, "NETWORK_INVALID");
    const options = { aliases };
    if (ipam.IPv4Address) options.ipv4_address = text(ipam.IPv4Address, "NETWORK_INVALID");
    if (ipam.IPv6Address) options.ipv6_address = text(ipam.IPv6Address, "NETWORK_INVALID");
    if (present(ipam.LinkLocalIPs)) options.link_local_ips = strings(ipam.LinkLocalIPs, "NETWORK_INVALID");
    if (present(endpoint.DriverOpts)) options.driver_opts = stringMap(endpoint.DriverOpts, "NETWORK_INVALID");
    if (present(endpoint.GwPriority)) options.gw_priority = integer(endpoint.GwPriority, "NETWORK_INVALID");
    // The new Compose service alias is automatic, not a replacement for any
    // original business alias. Keep the original aliases in the model.
    Object.defineProperty(result, name, { enumerable: true, value: options });
  }
  void member;
  return result;
}

const NUMERIC_HOST = Object.freeze({ Memory: "mem_limit", MemoryReservation: "mem_reservation", MemorySwap: "memswap_limit",
  CpuShares: "cpu_shares", CpuPeriod: "cpu_period", CpuQuota: "cpu_quota", CpuRealtimePeriod: "cpu_rt_period", CpuRealtimeRuntime: "cpu_rt_runtime",
  PidsLimit: "pids_limit", OomScoreAdj: "oom_score_adj", ShmSize: "shm_size", CpuCount: "cpu_count", CpuPercent: "cpu_percent" });
const ARRAY_HOST = Object.freeze({ CapAdd: "cap_add", CapDrop: "cap_drop", SecurityOpt: "security_opt", Dns: "dns", DnsOptions: "dns_opt",
  DnsSearch: "dns_search", ExtraHosts: "extra_hosts", GroupAdd: "group_add", DeviceCgroupRules: "device_cgroup_rules" });
const STRING_HOST = Object.freeze({ CpusetCpus: "cpuset", CgroupParent: "cgroup_parent", PidMode: "pid", UTSMode: "uts", UsernsMode: "userns_mode" });
const BOOL_HOST = Object.freeze({ ReadonlyRootfs: "read_only", Privileged: "privileged", OomKillDisable: "oom_kill_disable", Init: "init" });
const UNSUPPORTED_HOST = ["AutoRemove", "PublishAllPorts", "VolumesFrom", "Links", "ContainerIDFile", "LxcConf", "CpusetMems", "KernelMemory", "KernelMemoryTCP", "IOMaximumIOps", "IOMaximumBandwidth"];
const KNOWN_HOST = new Set([...Object.keys(NUMERIC_HOST), ...Object.keys(ARRAY_HOST), ...Object.keys(STRING_HOST), ...Object.keys(BOOL_HOST), ...UNSUPPORTED_HOST,
  "Binds", "Mounts", "PortBindings", "NetworkMode", "RestartPolicy", "VolumeDriver", "ConsoleSize", "Annotations", "LogConfig", "Ulimits", "NanoCpus", "MemorySwappiness",
  "IpcMode", "CgroupnsMode", "Cgroup", "Runtime", "Isolation", "StorageOpt", "Sysctls", "Tmpfs", "Devices", "DeviceRequests", "BlkioWeight", "BlkioWeightDevice",
  "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps", "MaskedPaths", "ReadonlyPaths"]);
function hostOptions(container) {
  const host = object(container.HostConfig, "CAPTURE_INVALID"), result = {};
  for (const key of Object.keys(host)) if (!KNOWN_HOST.has(key) && present(host[key])) fail("UNSUPPORTED_RUNTIME");
  for (const key of UNSUPPORTED_HOST) if (present(host[key])) fail("UNSUPPORTED_RUNTIME");
  for (const [key, target] of Object.entries(NUMERIC_HOST)) if (present(host[key])) result[target] = integer(host[key], "CAPTURE_INVALID");
  for (const [key, target] of Object.entries(ARRAY_HOST)) if (present(host[key])) result[target] = strings(host[key], "CAPTURE_INVALID");
  for (const [key, target] of Object.entries(STRING_HOST)) if (present(host[key])) {
    const value = text(host[key], "CAPTURE_INVALID");
    if (value.startsWith("container:")) fail("UNSUPPORTED_RUNTIME");
    result[target] = value;
  }
  for (const [key, target] of Object.entries(BOOL_HOST)) if (host[key] !== undefined && host[key] !== null) {
    if (typeof host[key] !== "boolean") fail("CAPTURE_INVALID");
    if (host[key]) result[target] = true;
  }
  if (host.MemorySwappiness !== undefined && host.MemorySwappiness !== null) result.mem_swappiness = integer(host.MemorySwappiness, "CAPTURE_INVALID");
  if (present(host.NanoCpus)) result.cpus = integer(host.NanoCpus, "CAPTURE_INVALID") / 1_000_000_000;
  if (present(host.IpcMode) && host.IpcMode !== "private") {
    if (text(host.IpcMode, "CAPTURE_INVALID").startsWith("container:")) fail("UNSUPPORTED_RUNTIME");
    result.ipc = host.IpcMode;
  }
  if (present(host.CgroupnsMode)) result.cgroup = text(host.CgroupnsMode, "CAPTURE_INVALID");
  if (present(host.Runtime)) result.runtime = text(host.Runtime, "CAPTURE_INVALID");
  if (present(host.Isolation) && host.Isolation !== "default") result.isolation = text(host.Isolation, "CAPTURE_INVALID");
  if (present(host.StorageOpt)) result.storage_opt = stringMap(host.StorageOpt, "CAPTURE_INVALID");
  if (present(host.Sysctls)) result.sysctls = stringMap(host.Sysctls, "CAPTURE_INVALID");
  if (present(host.Annotations)) result.annotations = stringMap(host.Annotations, "CAPTURE_INVALID");
  const restart = object(host.RestartPolicy ?? {}, "CAPTURE_INVALID"), policy = restart.Name || "no";
  if (!["no", "always", "unless-stopped", "on-failure"].includes(policy)) fail("CAPTURE_INVALID");
  const retries = integer(restart.MaximumRetryCount ?? 0, "CAPTURE_INVALID");
  if (retries < 0 || retries && policy !== "on-failure") fail("CAPTURE_INVALID");
  result.restart = policy === "on-failure" && retries ? `${policy}:${retries}` : policy;
  if (present(host.LogConfig)) {
    const logging = object(host.LogConfig, "CAPTURE_INVALID");
    if (!text(logging.Type, "CAPTURE_INVALID")) fail("CAPTURE_INVALID");
    result.logging = { driver: logging.Type, options: stringMap(logging.Config, "CAPTURE_INVALID") };
  }
  if (present(host.Ulimits)) {
    const seen = new Set();
    result.ulimits = Object.fromEntries(array(host.Ulimits, "CAPTURE_INVALID").map(limit => {
      object(limit, "CAPTURE_INVALID");
      if (!NAME.test(limit.Name ?? "") || seen.has(limit.Name)) fail("CAPTURE_INVALID");
      seen.add(limit.Name); return [limit.Name, { soft: integer(limit.Soft, "CAPTURE_INVALID"), hard: integer(limit.Hard, "CAPTURE_INVALID") }];
    }));
  }
  if (present(host.Devices)) result.devices = array(host.Devices, "CAPTURE_INVALID").map(device => {
    object(device, "CAPTURE_INVALID"); return `${text(device.PathOnHost, "CAPTURE_INVALID")}:${text(device.PathInContainer, "CAPTURE_INVALID")}:${text(device.CgroupPermissions, "CAPTURE_INVALID")}`;
  });
  if (present(host.DeviceRequests)) result.deploy = { resources: { reservations: { devices: array(host.DeviceRequests, "CAPTURE_INVALID").map(request => {
    object(request, "CAPTURE_INVALID");
    const capabilities = array(request.Capabilities, "CAPTURE_INVALID");
    if (capabilities.length !== 1) fail("UNSUPPORTED_RUNTIME");
    const ids = strings(request.DeviceIDs, "CAPTURE_INVALID");
    return { capabilities: strings(capabilities[0], "CAPTURE_INVALID"), ...(request.Driver ? { driver: text(request.Driver, "CAPTURE_INVALID") } : {}),
      ...(ids.length ? { device_ids: ids } : { count: request.Count === -1 ? "all" : integer(request.Count, "CAPTURE_INVALID") }),
      ...(present(request.Options) ? { options: stringMap(request.Options, "CAPTURE_INVALID") } : {}) };
  }) } } };
  const blkio = {};
  if (present(host.BlkioWeight)) blkio.weight = integer(host.BlkioWeight, "CAPTURE_INVALID");
  for (const [key, target] of Object.entries({ BlkioWeightDevice: "weight_device", BlkioDeviceReadBps: "device_read_bps", BlkioDeviceWriteBps: "device_write_bps", BlkioDeviceReadIOps: "device_read_iops", BlkioDeviceWriteIOps: "device_write_iops" })) {
    if (present(host[key])) blkio[target] = array(host[key], "CAPTURE_INVALID").map(value => ({ path: text(value.Path, "CAPTURE_INVALID"),
      [key === "BlkioWeightDevice" ? "weight" : "rate"]: integer(value[key === "BlkioWeightDevice" ? "Weight" : "Rate"], "CAPTURE_INVALID") }));
  }
  if (Object.keys(blkio).length) result.blkio_config = blkio;
  return result;
}

function imageReference(container, image) {
  if (!IMAGE_ID.test(image.Id ?? "") || image.Id !== container.Image) fail("IMAGE_INVALID");
  const digests = strings(image.RepoDigests ?? [], "IMAGE_INVALID");
  if (digests.some(value => !/^\S+@sha256:[a-f0-9]{64}$/.test(value))) fail("IMAGE_INVALID");
  const reference = text(container.Config.Image, "IMAGE_INVALID");
  const repository = reference.includes("@") ? reference.split("@")[0] : reference.replace(/:[^/:]+$/, "");
  return [...digests].sort().find(value => value.split("@")[0] === repository) ?? [...digests].sort()[0] ?? image.Id;
}

/** No I/O. Returned model is sensitive; summary is the only logging payload. */
export function buildUnifiedCompose({ inspections, images, project = "yummyai" } = {}) {
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail("PROJECT_INVALID");
  if (!Array.isArray(inspections) || inspections.length !== 10 || !Array.isArray(images)) fail("MEMBERSHIP_INVALID");
  const imageMap = new Map();
  for (const image of images) {
    object(image, "IMAGE_INVALID"); object(image.Config, "IMAGE_INVALID");
    if (!IMAGE_ID.test(image.Id ?? "")) fail("IMAGE_INVALID");
    if (imageMap.has(image.Id)) {
      const previous = imageMap.get(image.Id);
      if (!equal(previous.Config, image.Config) || !equal(unique(strings(previous.RepoDigests, "IMAGE_INVALID")), unique(strings(image.RepoDigests, "IMAGE_INVALID")))) fail("IMAGE_INVALID");
      continue;
    }
    imageMap.set(image.Id, image);
  }
  const services = [], summaries = [], diagnostics = [], externalVolumes = new Map(), externalNetworks = new Map(), seen = new Set(), names = new Set(), ids = new Set();
  for (const container of inspections) {
    const member = identity(container, true), config = member.config;
    if (seen.has(member.service) || names.has(member.name) || ids.has(container.Id)) fail("MEMBERSHIP_INVALID");
    seen.add(member.service); names.add(member.name); ids.add(container.Id);
    const image = imageMap.get(container.Image);
    if (!image) fail("IMAGE_INVALID");
    const defaults = object(image.Config, "IMAGE_INVALID"), actualEnv = environment(config.Env), defaultEnv = environment(defaults.Env ?? []);
    if (Object.keys(defaultEnv).some(key => !own(actualEnv, key))) fail("ENV_INVALID");
    const overrides = Object.fromEntries(Object.entries(actualEnv).filter(([key, value]) => !own(defaultEnv, key) || defaultEnv[key] !== value));
    const service = { image: imageReference(container, image), container_name: member.name, ...hostOptions(container) };
    if (Object.keys(overrides).length) service.environment = overrides;
    if (!equal(argv(config.Cmd), argv(defaults.Cmd))) service.command = argv(config.Cmd);
    if (!equal(argv(config.Entrypoint), argv(defaults.Entrypoint))) service.entrypoint = argv(config.Entrypoint);
    if (text(config.User ?? "", "CAPTURE_INVALID") !== text(defaults.User ?? "", "IMAGE_INVALID")) service.user = config.User ?? "";
    if (text(config.WorkingDir ?? "", "CAPTURE_INVALID") !== text(defaults.WorkingDir ?? "", "IMAGE_INVALID")) service.working_dir = config.WorkingDir ?? "";
    const checkedHealth = health(config.Healthcheck), defaultHealth = health(defaults.Healthcheck);
    if (!equal(checkedHealth, defaultHealth)) service.healthcheck = checkedHealth ?? { disable: true };
    const hostname = text(config.Hostname ?? "", "CAPTURE_INVALID");
    if (hostname && hostname !== container.Id && hostname !== container.Id.slice(0, 12)) service.hostname = hostname;
    if (config.Domainname) service.domainname = text(config.Domainname, "CAPTURE_INVALID");
    if (config.Tty) service.tty = true;
    if (config.OpenStdin) service.stdin_open = true;
    if (config.StdinOnce) fail("UNSUPPORTED_RUNTIME");
    if (config.StopSignal && config.StopSignal !== defaults.StopSignal) service.stop_signal = text(config.StopSignal, "CAPTURE_INVALID");
    if (config.StopTimeout !== undefined && config.StopTimeout !== null) service.stop_grace_period = `${integer(config.StopTimeout, "CAPTURE_INVALID")}s`;
    const imageLabels = stringMap(defaults.Labels, "IMAGE_INVALID");
    const labels = Object.fromEntries(Object.entries(stringMap(config.Labels, "CAPTURE_INVALID")).filter(([key, value]) =>
      !key.startsWith("com.docker.compose.") && (!own(imageLabels, key) || imageLabels[key] !== value)));
    if (Object.keys(labels).length) service.labels = labels;
    const capturedPorts = ports(container), publishedPorts = capturedPorts.ports;
    diagnostics.push(...capturedPorts.diagnostics);
    if (publishedPorts.length) service.ports = publishedPorts;
    const defaultExposed = object(defaults.ExposedPorts ?? {}, "IMAGE_INVALID"), exposed = object(config.ExposedPorts ?? {}, "PORT_INVALID");
    const extraPorts = Object.keys(exposed).filter(key => !own(defaultExposed, key));
    if (extraPorts.some(key => !/^\d+\/(tcp|udp|sctp)$/.test(key))) fail("PORT_INVALID");
    if (extraPorts.length) service.expose = extraPorts.sort();
    const mounted = mounts(container), tmpfs = stringMap(container.HostConfig.Tmpfs, "MOUNT_INVALID");
    const volumeMounts = mounted.filter(mount => mount.type !== "tmpfs" || !own(tmpfs, mount.target));
    if (volumeMounts.length) service.volumes = volumeMounts;
    if (Object.keys(tmpfs).length) service.tmpfs = Object.entries(tmpfs).sort(([a], [b]) => a.localeCompare(b)).map(([target, options]) => `${target}${options ? ":" + options : ""}`);
    for (const mount of mounted) if (mount.type === "volume") externalVolumes.set(mount.source, { name: mount.source, external: true });
    service.networks = networks(container, member);
    for (const name of Object.keys(service.networks)) externalNetworks.set(name, { name, external: true });
    if (member.service === "canvas-legacy") service.profiles = ["legacy-canvas"];
    services.push([member.service, service]);
    summaries.push({ name: member.name, service: member.service, container: container.Id, imageID: container.Image, sourceProject: member.sourceProject,
      ports: publishedPorts, mounts: mounted.map(mount => ({ type: mount.type, source: mount.source ?? null, target: mount.target, readOnly: mount.read_only })),
      networks: Object.keys(service.networks).sort() });
  }
  const expected = Object.values(MEMBERS).flatMap(value => Object.values(value));
  if (expected.some(value => !seen.has(value))) fail("MEMBERSHIP_INVALID");
  return {
    model: stable({ name: project, services: Object.fromEntries(services), volumes: Object.fromEntries(externalVolumes), networks: Object.fromEntries(externalNetworks) }),
    summary: stable({ name: project, count: inspections.length, services: summaries.sort((a, b) => a.service.localeCompare(b.service)),
      imageCount: new Set(inspections.map(value => value.Image)).size, volumeCount: externalVolumes.size, networkCount: externalNetworks.size, diagnostics }),
  };
}

/** Apply exactly once, immediately before serializing the private Compose file.
 * Compose interpolates string values, not mapping keys. No source is mutated. */
export function escapeComposeDollars(model) {
  const visit = value => typeof value === "string" ? value.replaceAll("$", () => "$$") : Array.isArray(value) ? value.map(visit) :
    isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)])) : stable(value);
  return visit(model);
}

/** Effective runtime comparison, including secrets: hash in memory, never log.
 * Compose ownership, generated IDs, ages, assigned IPs and automatic service
 * aliases are excluded. Static endpoint IPAM and original user aliases remain. */
export function inspectComparable(container, options = {}) {
  if (!isObject(options) || Object.keys(options).some(key => key !== "daemonSecurityOptions")) fail("PLATFORM_OPTIONS_INVALID");
  let inactiveSelinux = false;
  if (own(options, "daemonSecurityOptions")) {
    const security = options.daemonSecurityOptions;
    if (!Array.isArray(security) || !security.length || security.some(value => typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value)))
      fail("PLATFORM_OPTIONS_INVALID");
    // Only a caller's explicit, current daemon report permits this platform
    // normalization. An omitted/empty report never proves SELinux is absent.
    inactiveSelinux = !security.some(value => value.split(",").some(part => part.trim().toLowerCase() === "name=selinux"));
  }
  const member = identity(container), config = member.config;
  const endpoints = networks(container, member);
  for (const endpoint of Object.values(endpoints)) {
    if (member.service !== member.sourceService) endpoint.aliases = endpoint.aliases.filter(value => value !== member.service);
  }
  const mounted = mounts(container).map(mount => {
    const result = { ...mount };
    if (mount.type === "bind") result.source = sourcePath(mount.source);
    // This safety option controls creation, not an existing mounted filesystem.
    if (result.bind) {
      const { create_host_path: ignored, ...binding } = result.bind;
      void ignored;
      if (inactiveSelinux && ["Z", "z"].includes(binding.selinux)) delete binding.selinux;
      result.bind = binding;
    }
    return result;
  });
  const hostname = config.Hostname ?? "";
  return stable({ name: member.name, imageID: container.Image, environment: environment(config.Env), command: argv(config.Cmd), entrypoint: argv(config.Entrypoint),
    user: config.User ?? "", workingDirectory: config.WorkingDir ?? "", healthcheck: health(config.Healthcheck),
    hostname: [container.Id, container.Id.slice(0, 12)].includes(hostname) ? null : hostname, domainname: config.Domainname ?? "",
    tty: Boolean(config.Tty), stdinOpen: Boolean(config.OpenStdin), stdinOnce: Boolean(config.StdinOnce), stopSignal: config.StopSignal ?? "",
    stopTimeout: config.StopTimeout ?? null, exposedPorts: Object.keys(config.ExposedPorts ?? {}).sort(),
    labels: Object.fromEntries(Object.entries(stringMap(config.Labels, "CAPTURE_INVALID")).filter(([key]) => !key.startsWith("com.docker.compose."))),
    mounts: mounted, tmpfs: stringMap(container.HostConfig.Tmpfs, "MOUNT_INVALID"), ports: ports(container).ports, networks: endpoints,
    constraints: hostOptions(container), maskedPaths: strings(container.HostConfig.MaskedPaths, "CAPTURE_INVALID"), readonlyPaths: strings(container.HostConfig.ReadonlyPaths, "CAPTURE_INVALID") });
}
