import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildUnifiedCompose, escapeComposeDollars, inspectComparable } from "../scripts/lib/unified-compose-model.mjs";

const structuredClone = globalThis.structuredClone;

// Entirely synthetic Docker API objects. No Docker socket, subprocess, file,
// database, Worker or provider participates in this unit family.
const hash = value => createHash("sha256").update(value).digest("hex");
const imageId = value => "sha256:" + hash("synthetic-image:" + value);
const customValue = "SYNTHETIC-$APP-${LITERAL}-$$-VALUE";
const definitions = [
  ["infra", "postgres", "postgres", "postgres:17-alpine"],
  ["infra", "redis", "redis", "redis:8-alpine"],
  ["infra", "minio", "minio", "quay.io/minio/minio:synthetic"],
  ["infra", "keycloak", "keycloak", "quay.io/keycloak/keycloak:synthetic"],
  ["infra", "clamav", "clamav", "clamav/clamav:synthetic"],
  ["infra", "otel-collector", "otel-collector", "yummyai/otel-collector:local"],
  ["sub2api-deploy", "postgres", "sub2api-postgres", "postgres:18-alpine"],
  ["sub2api-deploy", "redis", "sub2api-redis", "redis:7-alpine"],
  ["sub2api-deploy", "sub2api", "sub2api", "synthetic/sub2api:v1"],
  ["yummyai-canvas", "canvas", "canvas-legacy", "ghcr.io/basketikun/infinite-canvas:synthetic"],
];
const volume = (name, target) => ({ Type: "volume", Name: name, Source: `/var/lib/docker/volumes/${name}/_data`, Destination: target, Driver: "local", Mode: "rw", RW: true, Propagation: "" });
const bind = (source, target, readOnly = false) => ({ Type: "bind", Source: source, Destination: target, Mode: readOnly ? "ro" : "rw", RW: !readOnly, Propagation: "rprivate" });
const port = (published, target) => [target + "/tcp", [{ HostIp: "127.0.0.1", HostPort: String(published) }]];
const anonymousParent = hash("synthetic-pg18-image-volume");

function fixture() {
  const images = [], inspections = [];
  for (const [index, [project, service, renamed, reference]] of definitions.entries()) {
    const id = hash("synthetic-container:" + index), name = `${project}-${service}-1`, network = project + "_default";
    const defaults = { Env: ["PATH=/usr/local/bin:/usr/bin", "SYNTHETIC_IMAGE_DEFAULT=preserved"], Cmd: ["image-default-command"],
      Entrypoint: ["/synthetic-entrypoint"], User: "", WorkingDir: "", Healthcheck: { Test: ["CMD", "image-default-health"], Interval: 30_000_000_000, Timeout: 5_000_000_000, Retries: 3 } };
    if (renamed === "sub2api-postgres") defaults.Env.push("PGDATA=/var/lib/postgresql/18/docker");
    const repository = reference.slice(0, reference.lastIndexOf(":"));
    images.push({ Id: imageId(reference), RepoTags: [reference], RepoDigests: renamed === "otel-collector" ? [] : [`${repository}@${imageId(reference)}`], Config: structuredClone(defaults) });
    const config = { ...structuredClone(defaults), Image: reference, Hostname: id.slice(0, 12), Domainname: "", AttachStdin: false, AttachStdout: true, AttachStderr: true,
      Tty: false, OpenStdin: false, StdinOnce: false, Labels: { "com.docker.compose.project": project, "com.docker.compose.service": service,
        "com.docker.compose.container-number": "1", "com.docker.compose.project.working_dir": `/synthetic/${project}`, "synthetic.operator-label": "keep-value" }, StopSignal: "SIGTERM" };
    config.Env.push("SYNTHETIC_SERVICE=" + renamed);
    let mounts = [], bindings = [];
    if (renamed === "postgres") { config.Env.push("PGDATA=/var/lib/postgresql/data"); mounts = [volume("infra_postgres-data", "/var/lib/postgresql/data")]; bindings = [port(5432, 5432)]; }
    if (renamed === "redis") { mounts = [volume("infra_redis-data", "/data")]; bindings = [port(6379, 6379)]; }
    if (renamed === "minio") { mounts = [volume("infra_minio-data", "/data")]; bindings = [port(19000, 9000), port(9001, 9001)]; }
    if (renamed === "keycloak") { mounts = [volume("infra_keycloak-data", "/opt/keycloak/data"), bind("/synthetic/infra/keycloak/realm-export.json", "/opt/keycloak/data/import/realm-export.json", true)]; bindings = [port(8081, 8080)]; }
    if (renamed === "clamav") { mounts = [volume("infra_clamav-data", "/var/lib/clamav")]; bindings = [port(3310, 3310)]; }
    if (renamed === "otel-collector") bindings = [port(4317, 4317), port(4318, 4318), port(13133, 13133)];
    if (renamed === "sub2api-postgres") {
      config.Env = config.Env.filter(value => !value.startsWith("PGDATA=")); config.Env.push("PGDATA=/data");
      mounts = [volume(anonymousParent, "/var/lib/postgresql"), bind("/synthetic/sub2api-deploy/data/postgres", "/data")];
    }
    if (renamed === "sub2api-redis") mounts = [bind("/synthetic/sub2api-deploy/data/redis", "/data")];
    if (renamed === "sub2api") {
      config.Env.push("SYNTHETIC_DOLLARS=" + customValue); config.Cmd = ["serve", "$APP", "${LITERAL}"];
      config.Entrypoint = ["/bin/sh", "-ec", "exec \"$APP\" \"$$\""]; config.User = "1001:1001"; config.WorkingDir = "/app";
      config.Healthcheck = { Test: ["CMD-SHELL", "test -n \"$APP\""], Interval: 15_000_000_000, Timeout: 4_000_000_000, StartPeriod: 10_000_000_000, Retries: 4 };
      mounts = [bind("/synthetic/sub2api-deploy/data/app", "/app/data")]; bindings = [port(8080, 8080)];
    }
    if (renamed === "canvas-legacy") bindings = [port(4175, 3000)];
    const ports = Object.fromEntries(bindings);
    inspections.push({ Id: id, Name: "/" + name, Created: "2026-10-23T00:00:00.000000000Z", Image: imageId(reference), Config: config,
      State: { Status: renamed === "canvas-legacy" ? "exited" : "running", Running: renamed !== "canvas-legacy", ExitCode: renamed === "canvas-legacy" ? 1 : 0,
        StartedAt: "2026-10-23T00:00:01.000000000Z", FinishedAt: "2026-10-23T00:00:02.000000000Z", Health: { Status: "healthy", Log: [] } },
      HostConfig: { NetworkMode: network, PortBindings: structuredClone(ports), RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        Memory: renamed === "sub2api" ? 536_870_912 : 0, MemorySwap: renamed === "sub2api" ? 1_073_741_824 : 0,
        NanoCpus: 0, CpuShares: renamed === "sub2api" ? 512 : 0, CpuPeriod: renamed === "sub2api" ? 100_000 : 0, CpuQuota: renamed === "sub2api" ? 50_000 : 0,
        PidsLimit: renamed === "sub2api" ? 256 : 0, ShmSize: 67_108_864, ReadonlyRootfs: false, Privileged: false, AutoRemove: false,
        Ulimits: renamed === "sub2api" ? [{ Name: "nofile", Soft: 2048, Hard: 4096 }] : [], CapAdd: null, CapDrop: null, SecurityOpt: null,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } } },
      Mounts: mounts, NetworkSettings: { Ports: structuredClone(ports), Networks: { [network]: { NetworkID: hash("network:" + network), EndpointID: hash("endpoint:" + name),
        Aliases: [name, service, id.slice(0, 12), "synthetic-user-alias-" + renamed], DNSNames: [name, id.slice(0, 12)], IPAddress: "172.30.0." + (index + 2),
        Gateway: "172.30.0.1", IPPrefixLen: 16, MacAddress: "02:42:ac:1e:00:02" } } } });
  }
  return { inspections, images };
}
const captured = (value, project, service) => value.inspections.find(row => row.Config.Labels["com.docker.compose.project"] === project && row.Config.Labels["com.docker.compose.service"] === service);
const environment = value => Array.isArray(value) ? Object.fromEntries(value.map(text => { const at = text.indexOf("="); return [text.slice(0, at), text.slice(at + 1)]; })) : value;
const mountedVolumeName = (model, mount) => model.volumes[mount.source]?.name;

test("the ten captured members keep one explicit project and two independent PostgreSQL and Redis services", () => {
  const input = fixture(), before = structuredClone(input), { model, summary } = buildUnifiedCompose(input);
  assert.equal(model.name, "yummyai"); assert.deepEqual(Object.keys(model.services).sort(), definitions.map(value => value[2]).sort());
  assert.deepEqual(input, before, "pure generation must not mutate captured Docker facts");
  assert.notEqual(model.services.postgres.image, model.services["sub2api-postgres"].image);
  assert.notEqual(model.services.redis.image, model.services["sub2api-redis"].image);
  assert.equal(environment(model.services.postgres.environment).PGDATA, "/var/lib/postgresql/data");
  assert.equal(environment(model.services["sub2api-postgres"].environment).PGDATA, "/data");
  assert.ok(!JSON.stringify(summary).includes(customValue));
  assert.ok(!JSON.stringify(summary).includes("test -n"));
  assert.ok(!JSON.stringify(summary).includes("keep-value"));
});

test("all five infra volumes and the PostgreSQL18 anonymous parent remain original external mounts", () => {
  const { model } = buildUnifiedCompose(fixture());
  const expected = ["infra_postgres-data", "infra_redis-data", "infra_minio-data", "infra_keycloak-data", "infra_clamav-data", anonymousParent];
  assert.deepEqual(Object.values(model.volumes).map(value => value.name).sort(), expected.sort());
  assert.ok(Object.values(model.volumes).every(value => value.external === true));
  const pg18 = model.services["sub2api-postgres"].volumes;
  assert.equal(mountedVolumeName(model, pg18.find(value => value.target === "/var/lib/postgresql")), anonymousParent);
  assert.deepEqual(pg18.find(value => value.target === "/data"), { type: "bind", source: "/synthetic/sub2api-deploy/data/postgres", target: "/data", read_only: false,
    bind: { create_host_path: false, propagation: "rprivate" } });
  assert.equal(model.services.keycloak.volumes.find(value => value.target.endsWith("realm-export.json")).read_only, true);
});

test("each original external network and user alias survives without merging the two databases", () => {
  const input = fixture(), { model } = buildUnifiedCompose(input);
  assert.deepEqual(Object.values(model.networks).map(value => value.name).sort(), ["infra_default", "sub2api-deploy_default", "yummyai-canvas_default"].sort());
  assert.ok(Object.values(model.networks).every(value => value.external === true));
  for (const [project, , service] of definitions) {
    const result = model.services[service], networkKey = Object.keys(result.networks).find(key => model.networks[key]?.name === project + "_default");
    assert.ok(networkKey, service); assert.ok(result.networks[networkKey].aliases.includes("synthetic-user-alias-" + service), service);
  }
  assert.notDeepEqual(model.services.postgres.networks, model.services["sub2api-postgres"].networks);
});

test("MinIO preserves only the actual loopback19000 and9001 bindings and never adds9000", () => {
  const { model } = buildUnifiedCompose(fixture()), ports = model.services.minio.ports;
  assert.equal(ports.length, 2);
  assert.deepEqual(ports.map(value => [value.host_ip, String(value.published), value.target, value.protocol]).sort(), [["127.0.0.1", "19000", 9000, "tcp"], ["127.0.0.1", "9001", 9001, "tcp"]].sort());
  assert.ok(!ports.some(value => String(value.published) === "9000"));
  const capturedMinio = () => {
    const input = fixture(), minio = captured(input, "infra", "minio");
    minio.HostConfig.PortBindings["9000/tcp"] = [{ HostIp: "", HostPort: "9000" }, { HostIp: "127.0.0.1", HostPort: "19000" }];
    minio.HostConfig.PortBindings["9001/tcp"] = [{ HostIp: "", HostPort: "9001" }];
    minio.NetworkSettings.Ports["9001/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "9001" }, { HostIp: "::", HostPort: "9001" }];
    return input;
  };
  const known = buildUnifiedCompose(capturedMinio()), actual = known.model.services.minio.ports;
  assert.deepEqual(actual, [{ target: 9000, published: "19000", protocol: "tcp", host_ip: "127.0.0.1" },
    { target: 9001, published: "9001", protocol: "tcp", host_ip: "::" }, { target: 9001, published: "9001", protocol: "tcp", host_ip: "0.0.0.0" }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.ok(!actual.some(value => value.published === "9000"), "an unbound original intent must not introduce a new live9000 listener");
  assert.deepEqual(known.summary.diagnostics, [{ code: "UNIFIED_COMPOSE_KNOWN_MINIO_INACTIVE_PORT_INTENT", sourceProject: "infra", service: "minio", container: "infra-minio-1",
    configured: { target: 9000, published: "9000", protocol: "tcp", host_ip: "" }, effective: [{ target: 9000, published: "19000", protocol: "tcp", host_ip: "127.0.0.1" }] }]);
  for (const mutate of [
    input => { captured(input, "infra", "minio").NetworkSettings.Ports["9000/tcp"] = null; },
    input => { captured(input, "infra", "minio").HostConfig.PortBindings["9000/tcp"][0].HostIp = "0.0.0.0"; },
    input => { captured(input, "infra", "minio").Name = "/not-the-original-minio"; },
    input => { const other = captured(input, "sub2api-deploy", "sub2api"); other.HostConfig.PortBindings["8080/tcp"].push({ HostIp: "", HostPort: "9000" }); },
  ]) { const input = capturedMinio(); mutate(input); assert.throws(() => buildUnifiedCompose(input), /UNIFIED_COMPOSE_PORT_INVALID/); }
});

test("stopped or created legacy canvas preserves4175 from configured bindings when effective ports are empty", () => {
  for (const status of ["exited", "created"]) for (const ports of [{}, { "3000/tcp": null }]) {
    const input = fixture(), canvas = captured(input, "yummyai-canvas", "canvas");
    canvas.State.Status = status; canvas.State.Running = false; canvas.NetworkSettings.Ports = structuredClone(ports);
    const { model } = buildUnifiedCompose(input);
    assert.deepEqual(model.services["canvas-legacy"].ports, [{ target: 3000, published: "4175", protocol: "tcp", host_ip: "127.0.0.1" }]);
    assert.deepEqual(model.services["canvas-legacy"].profiles, ["legacy-canvas"]);
  }
  for (const ports of [{}, { "9000/tcp": null, "9001/tcp": null }]) {
    const running = fixture(); captured(running, "infra", "minio").NetworkSettings.Ports = structuredClone(ports);
    assert.throws(() => buildUnifiedCompose(running), /UNIFIED_COMPOSE_PORT_INVALID/, "a live container cannot borrow configuration to hide missing actual bindings");
  }
});

test("each service pins its own captured digest or local image ID rather than a shared mutable upgrade", () => {
  const input = fixture(), { model } = buildUnifiedCompose(input);
  for (const [project, original, service] of definitions) {
    const source = captured(input, project, original), image = input.images.find(value => value.Id === source.Image);
    assert.equal(model.services[service].image, image.RepoDigests[0] ?? image.Id, service);
  }
  const changed = fixture(); changed.images.find(value => value.Id === imageId("postgres:18-alpine")).RepoDigests = [];
  const result = buildUnifiedCompose(changed).model;
  assert.equal(result.services["sub2api-postgres"].image, imageId("postgres:18-alpine"));
  assert.equal(result.services.postgres.image, model.services.postgres.image);
});

test("image defaults are omitted while actual environment command health user directory and limits overrides remain", () => {
  const { model } = buildUnifiedCompose(fixture()), service = model.services.sub2api, values = environment(service.environment);
  assert.equal(values.SYNTHETIC_DOLLARS, customValue); assert.equal(values.PATH, undefined); assert.equal(values.SYNTHETIC_IMAGE_DEFAULT, undefined);
  assert.deepEqual(service.command, ["serve", "$APP", "${LITERAL}"]);
  assert.deepEqual(service.entrypoint, ["/bin/sh", "-ec", "exec \"$APP\" \"$$\""]);
  assert.equal(service.user, "1001:1001"); assert.equal(service.working_dir, "/app");
  assert.deepEqual(service.healthcheck.test, ["CMD-SHELL", "test -n \"$APP\""]);
  assert.equal(service.healthcheck.interval, "15000000000ns"); assert.equal(service.healthcheck.timeout, "4000000000ns");
  assert.equal(service.healthcheck.start_period, "10000000000ns"); assert.equal(service.healthcheck.retries, 4);
  assert.equal(service.mem_limit, 536_870_912); assert.equal(service.memswap_limit, 1_073_741_824);
  assert.equal(service.cpu_shares, 512); assert.equal(service.cpu_period, 100_000); assert.equal(service.cpu_quota, 50_000); assert.equal(service.pids_limit, 256);
  assert.deepEqual(service.ulimits.nofile, { soft: 2048, hard: 4096 });
  assert.equal(model.services.postgres.command, undefined); assert.equal(model.services.postgres.entrypoint, undefined); assert.equal(model.services.postgres.healthcheck, undefined);
  const privileged = fixture(); captured(privileged, "sub2api-deploy", "sub2api").HostConfig.Privileged = true;
  assert.equal(buildUnifiedCompose(privileged).model.services.sub2api.privileged, true, "capture preserves existing security settings rather than silently changing them");
});

test("Compose interpolation escaping doubles each original dollar once without mutating source values or keys", () => {
  const source = { environment: { "$synthetic-key": customValue }, command: ["$APP", "${LITERAL}", "$$"], nested: [null, true, 3, { value: "x$y" }] };
  const before = structuredClone(source), result = escapeComposeDollars(source);
  assert.deepEqual(source, before); assert.notEqual(result, source); assert.notEqual(result.environment, source.environment);
  assert.equal(result.environment["$synthetic-key"], "SYNTHETIC-$$APP-$${LITERAL}-$$$$-VALUE");
  assert.deepEqual(result.command, ["$$APP", "$${LITERAL}", "$$$$"]); assert.deepEqual(result.nested, [null, true, 3, { value: "x$$y" }]);
  const raw = buildUnifiedCompose(fixture()).model, escaped = escapeComposeDollars(raw);
  assert.equal(environment(raw.services.sub2api.environment).SYNTHETIC_DOLLARS, customValue);
  assert.equal(environment(escaped.services.sub2api.environment).SYNTHETIC_DOLLARS, "SYNTHETIC-$$APP-$${LITERAL}-$$$$-VALUE");
});

test("the stopped legacy canvas remains opt-in and no ERP Web API or Worker is invented", () => {
  const { model } = buildUnifiedCompose(fixture());
  assert.deepEqual(model.services["canvas-legacy"].profiles, ["legacy-canvas"]);
  assert.ok(Object.keys(model.services).every(name => !["api", "web", "worker", "studio"].includes(name)));
  assert.ok(Object.entries(model.services).filter(([name]) => name !== "canvas-legacy").every(([, value]) => !value.profiles?.includes("legacy-canvas")));
  assert.throws(() => buildUnifiedCompose({ ...fixture(), project: "../untrusted" }), /UNIFIED_COMPOSE_PROJECT_INVALID/);
});

test("unknown missing duplicate or incomplete captured members fail closed before any model can be adopted", () => {
  for (const mutate of [
    value => value.inspections.pop(),
    value => value.inspections.push(structuredClone(value.inspections[0])),
    value => { value.inspections[0].Config.Labels["com.docker.compose.project"] = "ordinary-unknown"; },
    value => { value.inspections[0].Config.Labels["com.docker.compose.service"] = "worker"; },
    value => { delete value.inspections[0].Image; },
    value => { value.images = value.images.filter(image => image.Id !== value.inspections[0].Image); },
    value => { delete value.inspections[0].Mounts; },
    value => { delete value.inspections[0].NetworkSettings.Networks; },
    value => { value.inspections[0].Config.Env.push("SYNTHETIC_SERVICE=duplicate"); },
    value => { value.inspections[0].HostConfig.AutoRemove = true; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => buildUnifiedCompose(value), /UNIFIED_COMPOSE_[A-Z_]+/); }
});

test("comparison accepts only changed container identity Compose labels timestamps IP and known automatic aliases", () => {
  const value = captured(fixture(), "sub2api-deploy", "postgres"), changed = structuredClone(value), newId = hash("synthetic-recreated-container");
  changed.Id = newId; changed.Config.Hostname = newId.slice(0, 12); changed.Created = "2026-10-24T00:00:00Z";
  changed.Config.Labels["com.docker.compose.project"] = "yummyai"; changed.Config.Labels["com.docker.compose.service"] = "sub2api-postgres";
  changed.Config.Labels["com.docker.compose.project.working_dir"] = "/synthetic/new-project";
  changed.State.StartedAt = "2026-10-24T00:00:01Z"; changed.State.FinishedAt = "2026-10-24T00:00:02Z";
  const network = changed.NetworkSettings.Networks["sub2api-deploy_default"];
  network.EndpointID = hash("new-endpoint"); network.IPAddress = "172.30.0.99"; network.MacAddress = "02:42:ac:1e:00:99";
  network.Aliases = ["postgres", "sub2api-postgres", value.Name.slice(1), newId.slice(0, 12), "synthetic-user-alias-sub2api-postgres"];
  network.DNSNames = [value.Name.slice(1), newId.slice(0, 12)];
  assert.deepEqual(inspectComparable(changed), inspectComparable(value));
});

test("comparison rejects changed original environment image ports mounts user aliases health commands or limits", () => {
  const original = captured(fixture(), "sub2api-deploy", "sub2api"), before = inspectComparable(original);
  for (const mutate of [
    value => { value.Config.Env = value.Config.Env.map(text => text.startsWith("SYNTHETIC_DOLLARS=") ? "SYNTHETIC_DOLLARS=changed" : text); },
    value => { value.Image = imageId("different-image"); },
    value => { value.Name = "/changed-original-container-name"; },
    value => { value.HostConfig.PortBindings["8080/tcp"][0].HostPort = "18080"; value.NetworkSettings.Ports["8080/tcp"][0].HostPort = "18080"; },
    value => { value.Mounts[0].Source = "/synthetic/other-data"; },
    value => { value.Mounts[0].RW = false; value.Mounts[0].Mode = "ro"; },
    value => { value.NetworkSettings.Networks["sub2api-deploy_default"].Aliases.push("unreviewed-user-alias"); },
    value => { value.Config.Healthcheck.Test = ["CMD", "different-health"]; },
    value => { value.Config.Cmd = ["different-command"]; },
    value => { value.HostConfig.Memory += 1; },
  ]) { const changed = structuredClone(original); mutate(changed); assert.notDeepEqual(inspectComparable(changed), before); }
});

test("explicit daemon SELinux absence ignores only inactive bind relabel flags while every effective mount field stays strict", () => {
  const disabled = { daemonSecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] };
  const enabled = ["name=selinux", "name=SELinux,profile=synthetic"].map(value => ({ daemonSecurityOptions: [...disabled.daemonSecurityOptions, value] }));
  for (const flag of ["z", "Z"]) {
    const original = captured(fixture(), "sub2api-deploy", "sub2api"), changed = structuredClone(original);
    original.Mounts[0].Mode = "rw," + flag; changed.Mounts[0].Mode = "";
    const retained = structuredClone(original), before = inspectComparable(original, disabled);
    assert.deepEqual(inspectComparable(changed, disabled), before);
    assert.deepEqual(original, retained, "comparison cannot rewrite the captured original relabel request");
    assert.notDeepEqual(inspectComparable(changed), inspectComparable(original), "missing daemon proof keeps the old strict comparison");
    assert.notDeepEqual(inspectComparable(changed, {}), inspectComparable(original, {}));
    for (const options of enabled) assert.notDeepEqual(inspectComparable(changed, options), inspectComparable(original, options), "an enabled SELinux daemon must retain the relabel difference");
    for (const mutate of [
      value => { value.Mounts[0].Source = "/synthetic/different-source"; },
      value => { value.Mounts[0].Destination = "/app/different-target"; },
      value => { value.Mounts[0].RW = false; value.Mounts[0].Mode = "ro"; },
      value => { value.Mounts[0].Propagation = "rshared"; },
    ]) { const different = structuredClone(changed); mutate(different); assert.notDeepEqual(inspectComparable(different, disabled), before); }
  }
  const value = captured(fixture(), "sub2api-deploy", "sub2api");
  for (const invalid of [null, [], { daemonSecurityOptions: null }, { daemonSecurityOptions: "name=seccomp" }, { daemonSecurityOptions: [] },
    { daemonSecurityOptions: [null] }, { daemonSecurityOptions: [" "] }, { ...disabled, ignoreMounts: true }]) {
    assert.throws(() => inspectComparable(value, invalid), /UNIFIED_COMPOSE_PLATFORM_OPTIONS_INVALID/);
  }
});
