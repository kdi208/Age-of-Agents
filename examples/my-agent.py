# A minimal agent for the Fleet HUD: it reports what it is doing and obeys orders.
# Start the bridge first (node fleet-bridge.js), then: python3 examples/my-agent.py
import json, os, random, time, urllib.request

BRIDGE = "http://127.0.0.1:4545"
TOKEN = open(os.path.expanduser("~/.fleet-bridge/token")).read().strip()
ME = "py-worker"

def call(method, path, body=None):
    req = urllib.request.Request(BRIDGE + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"X-Fleet-Token": TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def report(**fields):
    call("POST", "/api/agents", {"id": ME, "team": "python", "role": "builder", **fields})

task, paused, step = "Resize 50 images", False, 0
report(status="working", area="images", task=task, log="Started")

while True:
    for order in call("GET", f"/api/commands?agent={ME}")["commands"]:
        if order["order"] == "pause": paused = True; report(status="paused", log="Paused")
        if order["order"] in ("resume", "approve"): paused = False; report(status="working", waitingOn="", log="Carrying on")
        if order["order"] == "deny": paused = False; report(status="working", waitingOn="", log="Skipped the upload")
        if order["order"] == "redirect": task = order["text"]; report(status="working", task=task, log="New order")
        if order["order"] == "stop": report(status="done", log="Stopped"); raise SystemExit
    if not paused:
        step += 1
        if step % 12 == 0:
            paused = True  # ask before doing something risky, then wait for Approve or Deny
            report(status="approval", waitingOn="upload the results to the shared drive")
        else:
            report(status="working", area=random.choice(["images", "thumbnails", "uploads"]),
                   log=f"Step {step}: processed image {step}", tasks=step // 5, cost=round(step * 0.01, 2))
    time.sleep(2)
