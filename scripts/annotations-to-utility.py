"""Converts CS2 map-guide annotations into a utility library seed.

Reads the KV3 annotation files of github.com/ReneRebsdorf/CS2-annotations (MIT)
and writes the payload POST /utility/import and the boot seeder both accept.

    python scripts/annotations-to-utility.py <CS2-annotations checkout> <out.json>

A lineup in that format is three nodes tied together by MasterNodeId: the
'main' node is where you stand, the 'aim_target' node carries the view angles
you throw with, and the 'destination' node is where the grenade lands.
"""

import json
import re
import sys
from pathlib import Path

SOURCE_URL = "https://github.com/ReneRebsdorf/CS2-annotations"

NODE = re.compile(r"^\tMapAnnotationNode\d+ = \n\t\{\n(.*?)^\t\}", re.M | re.S)
VECTOR = r"\[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]"

# "Smoke CT" is a smoke onto CT, thrown by T, so a bare "CT" says nothing about
# who throws. What does: a retake or hold, or a title whose second line names a
# CT spot as the place you throw from. Anything else is filed as T, which is
# what most published lineups are.
CT_THROW = re.compile(
    r"\b(retakes?|hold(ing)?|anti[- ]?(rush|push)|defen[cs]e|from ct)\b", re.I
)
CT_ORIGIN = re.compile(r"^ct\b", re.I)

STRENGTH = [
    (re.compile(r"\b(middle|mid)[- ]?(click|powered|throw)|\bboth (buttons|clicks)\b", re.I), "half"),
    (re.compile(r"\bright[- ]?click\b", re.I), "drop"),
]


def field(body: str, name: str, depth: int = 2) -> str | None:
    match = re.search(rf"^{chr(9) * depth}{name} = (.+)$", body, re.M)
    return match.group(1).strip() if match else None


def vector(body: str, name: str) -> list[float] | None:
    match = re.search(rf"^\t\t{name} = {VECTOR}", body, re.M)
    return [float(v) for v in match.groups()] if match else None


def text(body: str, block: str) -> str:
    match = re.search(
        rf"^\t\t{block} = \n\t\t\{{\n\t\t\tText = \"(.*?)\"$", body, re.M | re.S
    )
    if not match:
        return ""
    return match.group(1).replace("\\n", "\n").strip()


def unquote(value: str | None) -> str | None:
    return value.strip('"') if value else value


def side(title_lines: list[str], description: str) -> str:
    if CT_THROW.search(" ".join(title_lines + [description])):
        return "CT"
    if any(CT_ORIGIN.search(line) for line in title_lines[1:]):
        return "CT"
    return "T"


def technique(jump: bool, description: str) -> str:
    text = description.lower()
    moving = None
    if re.search(r"\brun", text):
        moving = "Run"
    elif re.search(r"\bwalk", text):
        moving = "Walk"
    elif re.search(r"\bcrouch", text):
        moving = "Crouch"
    if jump:
        return {"Run": "RunJump", "Walk": "WalkJump", "Crouch": "CrouchJump"}.get(
            moving, "Jump"
        )
    return {"Run": "Running", "Walk": "Walking", "Crouch": "Crouch"}.get(
        moving, "Stationary"
    )


def strength(description: str) -> str | None:
    for pattern, value in STRENGTH:
        if pattern.search(description):
            return value
    return None


def read_map(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8")
    map_name = unquote(field(raw, "MapName", depth=1))
    nodes = []
    for match in NODE.finditer(raw):
        body = match.group(1)
        nodes.append(
            {
                "type": unquote(field(body, "Type")),
                "id": unquote(field(body, "Id")),
                "sub": unquote(field(body, "SubType")),
                "master": unquote(field(body, "MasterNodeId")),
                "enabled": field(body, "Enabled") != "false",
                "position": vector(body, "Position"),
                "angles": vector(body, "Angles"),
                "title": text(body, "Title"),
                "desc": text(body, "Desc"),
                "jump": field(body, "JumpThrow") == "true",
                "grenade": unquote(field(body, "GrenadeType")),
            }
        )

    by_master: dict[str, dict[str, dict]] = {}
    for node in nodes:
        if node["master"]:
            by_master.setdefault(node["master"], {})[node["sub"]] = node

    lineups = []
    for main in nodes:
        if main["type"] != "grenade" or main["sub"] != "main" or not main["enabled"]:
            continue
        children = by_master.get(main["id"], {})
        aim = children.get("aim_target")
        land = children.get("destination")
        if not aim or not land or not main["grenade"]:
            continue

        title_lines = [
            line.strip()
            for line in (main["title"] or aim["title"]).splitlines()
            if line.strip()
        ]
        description = "\n".join(t for t in (main["desc"], aim["desc"]) if t)
        lineups.append(
            {
                "external_id": f"cs2-annotations:{main['id']}",
                "map_name": map_name,
                "utility_type": main["grenade"],
                "side": side(title_lines, description),
                "technique": technique(main["jump"], description),
                "throw_strength": strength(description),
                "jump_throw_bind": main["jump"],
                "origin": main["position"],
                "land": land["position"],
                "view_pitch": aim["angles"][0],
                "view_yaw": aim["angles"][1],
                "name": " · ".join(title_lines)[:120],
                "description": description or None,
                "source_url": SOURCE_URL,
            }
        )
    return lineups


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    lineups = []
    for path in sorted(root.glob("local/*/*.txt")):
        lineups.extend(read_map(path))
    out.write_text(
        json.dumps({"visibility": "Public", "lineups": lineups}, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"{len(lineups)} lineups -> {out}")


if __name__ == "__main__":
    main()
