import net from "node:net";
import process from "node:process";

const listenHost = process.env.LISTEN_HOST ?? "127.0.0.1";
const listenPort = requiredPort("LISTEN_PORT");
const targetHost = process.env.TARGET_HOST ?? "127.0.0.1";
const targetPort = requiredPort("TARGET_PORT");

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  upstream.once("error", close);
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(
    `TCP proxy listening on ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}\n`,
  );
});

function requiredPort(name) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}
