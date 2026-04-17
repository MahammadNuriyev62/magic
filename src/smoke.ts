import { SessionManager } from "./session.js";

async function main() {
  const mgr = new SessionManager();
  console.log("opening session...");
  const info = await mgr.open({ name: "studio", host: "studio" });
  console.log("opened:", info);

  console.log("\n-- run 1: pwd & hostname --");
  let r = await mgr.get("studio").run("pwd && hostname && echo OK", 10000);
  console.log(r);

  console.log("\n-- run 2: cd persistence --");
  r = await mgr.get("studio").run("cd /tmp && pwd", 10000);
  console.log(r);

  r = await mgr.get("studio").run("pwd", 10000);
  console.log("cwd after 'cd /tmp' in separate run:", r);

  console.log("\n-- run 3: env var persistence --");
  await mgr.get("studio").run("export FOO=bar", 5000);
  r = await mgr.get("studio").run("echo $FOO", 5000);
  console.log(r);

  console.log("\n-- run 4: short timeout + ssh_read tailing --");
  r = await mgr.get("studio").run("for i in 1 2 3 4 5; do echo tick $i; sleep 1; done", 1500);
  console.log("first return (should be 'running'):", r);
  r = await mgr.get("studio").read(3000);
  console.log("after 3s wait:", r);
  r = await mgr.get("studio").read(5000);
  console.log("after another 5s wait:", r);

  console.log("\n-- run 5: signal interrupt --");
  r = await mgr.get("studio").run("sleep 30 && echo SHOULD_NOT_SEE", 500);
  console.log("started, running:", r.status);
  mgr.get("studio").signal("INT");
  r = await mgr.get("studio").read(3000);
  console.log("after SIGINT:", r);

  console.log("\n-- list --");
  console.log(mgr.list());

  console.log("\n-- close --");
  mgr.close("studio");
  console.log(mgr.list());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
