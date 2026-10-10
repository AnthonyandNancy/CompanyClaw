"""
Reproducible evidence that the vendored Windows-MCP payload really works.

Run it against an assembled payload (see
`desktop/scripts/prepare-windows-mcp-resources.mjs`):

    cd desktop/resources/companyclaw-broker/windows-mcp
    ./python-runtime/Scripts/python.exe ../../../../docs/companyclaw/v5/scripts/verify-windows-mcp-handshake.py

What it proves, and why each part matters:

  * the server starts from the *private* interpreter inside the payload, so the
    employee's machine needs no Python of its own;
  * `initialize` and `tools/list` succeed over stdio, so the adapter is talking
    to a real MCP server rather than a stub with the same name;
  * the advertised tool names match `PINNED_UPSTREAM_TOOLS` in
    `broker/adapters/windows-mcp/tool-policy-map.ts`, so the allow-map is
    reviewing the release that actually ships.

Exit code is non-zero when any of those fail, so it can be wired into CI.
"""
import json, os, subprocess, sys
payload = os.path.abspath(".")
py = os.path.join(payload, "python-runtime", "Scripts", "python.exe")
server = os.path.join(payload, "server")
env = dict(os.environ)
env.update({
  "ANONYMIZED_TELEMETRY": "false",
  "WINDOWS_MCP_WATCHDOG": "off",
  "PYTHONNOUSERSITE": "1",
  "PYTHONDONTWRITEBYTECODE": "1",
  "PYTHONPATH": server,
})
p = subprocess.Popen([py, "-m", "windows_mcp", "serve", "--transport", "stdio"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     env=env, text=True, encoding="utf-8", cwd=server)
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claw","version":"1"}}})+"\n")
p.stdin.flush()
line = p.stdout.readline()
print("INIT:", line.strip()[:200])
p.stdin.write(json.dumps({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})+"\n")
p.stdin.write(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})+"\n")
p.stdin.flush()
line = p.stdout.readline()
data = json.loads(line)
print("TOOLS:", len(data["result"]["tools"]))
print("NAMES:", ",".join(t["name"] for t in data["result"]["tools"]))
expected = sorted([
    "App", "DisplayInventory", "PowerShell", "FileSystem", "Snapshot", "Screenshot",
    "Click", "Type", "Scroll", "Move", "Shortcut", "Wait", "WaitFor", "Scrape",
    "MultiSelect", "MultiEdit", "Clipboard", "Process", "Notification", "Registry",
])
actual = sorted(t["name"] for t in data["result"]["tools"])
if actual != expected:
    print("MISMATCH: the shipped release no longer matches the reviewed allow-map")
    print("missing:", sorted(set(expected) - set(actual)))
    print("unclassified:", sorted(set(actual) - set(expected)))
    sys.exit(1)
print("OK: 20 tools, allow-map in sync")

p.stdin.close()
try:
    p.wait(timeout=10)
except Exception:
    p.kill()
