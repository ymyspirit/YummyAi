import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStudioComparable } from "../scripts/studio-runtime-deployment.mjs";

const recorded = () => ({ Config: { User: "1000:1000", Cmd: ["node", "server.mjs"] },
  HostConfig: { Dns: null, DnsOptions: null, DnsSearch: null, ReadonlyRootfs: true,
    CapDrop: ["ALL"], PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "4176" }] } },
  Mounts: [], networks: ["yummyai_studio-runtime", "yummyai_studio-runtime-entry"] });

test("Docker restart's null to empty DNS slices preserve the recorded configuration", () => {
  const before = recorded(), unchanged = JSON.parse(JSON.stringify(before)), after = recorded();
  for (const key of ["Dns", "DnsOptions", "DnsSearch"]) after.HostConfig[key] = [];
  assert.deepEqual(normalizeStudioComparable(before), normalizeStudioComparable(after));
  assert.deepEqual(before, unchanged);
});

test("explicit DNS overrides and missing fields remain configuration changes", () => {
  for (const [key, value] of [["Dns", ["1.1.1.1"]], ["DnsOptions", ["ndots:0"]], ["DnsSearch", ["."]]]) {
    const after = recorded(); after.HostConfig[key] = value;
    assert.notDeepEqual(normalizeStudioComparable(recorded()), normalizeStudioComparable(after));
    delete after.HostConfig[key];
    assert.notDeepEqual(normalizeStudioComparable(recorded()), normalizeStudioComparable(after));
  }
});

test("DNS normalization preserves port, isolation, identity and immutable runtime checks", () => {
  const changes = [value => { value.HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"; },
    value => { value.HostConfig.ReadonlyRootfs = false; }, value => { value.HostConfig.CapDrop = []; },
    value => { value.Config.User = "0:0"; }, value => { value.Config.Cmd[1] = "changed.mjs"; },
    value => { value.Mounts.push({ Source: "/data", Destination: "/app" }); },
    value => { value.networks.push("default"); }];
  for (const change of changes) {
    const after = recorded(); change(after);
    assert.notDeepEqual(normalizeStudioComparable(recorded()), normalizeStudioComparable(after));
  }
});
