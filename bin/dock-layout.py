#!/usr/bin/env python3
"""Builds the Voice Agent strip into a Herdr layout file.

  dock-layout.py LAYOUT.json

Adds a 72 px block showing the voice-agent mod to the layout's "work" column, just above the
status bar. Herdr's own layouts are read-only, so install.sh --dock runs this on a personal copy
of "main" (layout.clone). Running it again changes nothing.
"""
import json
import os
import sys

STRIP = {"id": "voice-agent", "type": "block", "content": {"mod": "voice-agent"}, "size": {"px": 72}, "min": 72}


def find(node, node_id):
    if node.get("id") == node_id:
        return node
    for child in node.get("children", []):
        hit = find(child, node_id)
        if hit:
            return hit
    return None


def main():
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    with open(path) as f:
        layout = json.load(f)
    if find(layout, STRIP["id"]):
        return
    work = find(layout, "work")
    if not work or work.get("type") != "column":
        sys.exit(f"{path} has no 'work' column to put the strip in; use the floating banner instead.")
    ids = [child.get("id") for child in work.get("children", [])]
    work.setdefault("children", []).insert(ids.index("status") if "status" in ids else len(ids), STRIP)
    with open(path + ".tmp", "w") as f:
        json.dump(layout, f, indent=2)
        f.write("\n")
    os.replace(path + ".tmp", path)


if __name__ == "__main__":
    main()
