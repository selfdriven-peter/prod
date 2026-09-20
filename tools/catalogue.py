#!/usr/bin/env python3
"""
Build docs/data/catalogue.js from the pages themselves.

Every page declares what it is in its own <head>:

    <meta name="sd:title" content="Poker Night">
    <meta name="sd:group" content="other">
    <meta name="sd:tone"  content="gold">
    <meta name="sd:icon"  content="ic-spade">
    <meta name="sd:tag"   content="soon">
    <meta name="sd:line"  content="The where, the when and the house rules.">
    <meta name="sd:cta"   content="Deal me in">
    <meta name="sd:order" content="10">

Anything missing falls back to <title> and <meta name="description">, so a page
with no sd: tags at all still shows up sensibly.

Visibility is NOT a tag — it comes from which repo the file is in. A page in
prod/docs/pages is public; a page in the private vault is locked. That way a
page cannot be published by mistake by mistyping a tag.

    python3 tools/catalogue.py            # rebuild
    python3 tools/catalogue.py --check    # verify it is up to date, change nothing
    python3 tools/catalogue.py --list     # print what it found
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "catalogue.json")
OUTPUT = os.path.join(ROOT, "docs", "data", "catalogue.js")

META_RE = re.compile(
    r"""<meta\s+name=["']sd:(?P<key>[a-z]+)["']\s+content=["'](?P<val>[^"']*)["']""",
    re.I,
)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.I | re.S)
DESC_RE = re.compile(
    r"""<meta\s+name=["']description["']\s+content=["']([^"']*)["']""", re.I
)


def read_head(path):
    """Read only the <head> — pages can be 150KB and we need the first slice."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        blob = fh.read(16384)
    cut = re.split(r"</head>", blob, maxsplit=1, flags=re.I)
    return cut[0]


def tidy_title(raw):
    """Strip the site furniture off a <title>.

    Two conventions are in play and they point opposite ways:
        'selfdriven.you · Have a go.'   -> the name is AFTER the dot
        'Poker Night — next one soon'   -> the name is BEFORE the dash
    """
    t = re.sub(r"\s+", " ", raw).strip()
    for sep in ("·", "•"):
        if sep in t:
            t = t.split(sep)[-1].strip()
    for sep in ("—", "–", "|", " - "):
        if sep in t:
            t = t.split(sep)[0].strip()
    return t.rstrip(".").strip() or "Untitled"


def first_sentence(text, limit=110):
    t = re.sub(r"\s+", " ", text).strip()
    if not t:
        return ""
    m = re.match(r"^(.{20,%d}?[.!?])\s" % limit, t)
    if m:
        return m.group(1).strip()
    return (t[: limit - 1] + "…") if len(t) > limit else t


def parse_page(path, defaults):
    head = read_head(path)
    meta = {m.group("key").lower(): m.group("val").strip() for m in META_RE.finditer(head)}
    if "skip" in meta:
        return None  # redirect stub, draft, or anything else not for the index

    title_m = TITLE_RE.search(head)
    desc_m = DESC_RE.search(head)
    fallback_title = tidy_title(title_m.group(1)) if title_m else ""
    fallback_line = first_sentence(desc_m.group(1)) if desc_m else ""

    stem = os.path.splitext(os.path.basename(path))[0]

    try:
        order = int(meta.get("order", defaults["order"]))
    except ValueError:
        order = defaults["order"]

    return {
        "stem": stem,
        "title": meta.get("title") or fallback_title or stem,
        "group": meta.get("group", "").strip(),
        "tone": meta.get("tone", "").strip(),
        "icon": meta.get("icon") or defaults["icon"],
        "tag": meta.get("tag", "").strip(),
        "line": meta.get("line") or fallback_line,
        "cta": meta.get("cta") or defaults["cta"],
        "order": order,
        "_annotated": bool(meta),
    }


def collect(cfg):
    defaults = cfg["defaults"]
    group_ids = {g["id"] for g in cfg["groups"]}
    group_tone = {g["id"]: g["tone"] for g in cfg["groups"]}
    sites, warnings = [], []

    # ── public pages ─────────────────────────────────────────────────────────
    pub_dir = os.path.join(ROOT, cfg["public"]["pages_dir"])
    for name in sorted(os.listdir(pub_dir)) if os.path.isdir(pub_dir) else []:
        if not name.endswith(".html"):
            continue
        page = parse_page(os.path.join(pub_dir, name), defaults)
        if page is None:
            continue
        if not page["group"]:
            page["group"] = "other"
            warnings.append('%s has no sd:group — filed under "other"' % name)
        elif page["group"] not in group_ids:
            warnings.append(
                '%s declares group "%s", which is not in catalogue.json'
                % (name, page["group"])
            )
        if page["group"] == cfg["vault"]["group"]:
            warnings.append(
                "%s is in the PUBLIC repo but declares the vault group — "
                "it is publicly readable" % name
            )
        page["href"] = cfg["public"]["href_prefix"] + name
        page["locked"] = False
        page.setdefault("tone", "")
        page["tone"] = page["tone"] or group_tone.get(page["group"], "chill")
        sites.append(page)

    # ── vault pages ──────────────────────────────────────────────────────────
    vault_dir = os.path.join(ROOT, cfg["vault"]["repo_path"], cfg["vault"]["pages_dir"])
    vault_dir = os.path.normpath(vault_dir)
    vault_group = cfg["vault"]["group"]
    if os.path.isdir(vault_dir):
        for folder in sorted(os.listdir(vault_dir)):
            fpath = os.path.join(vault_dir, folder)
            if not os.path.isdir(fpath) or "-" not in folder:
                continue
            key = folder.split("-", 1)[1]
            for name in sorted(os.listdir(fpath)):
                if not name.endswith(".html"):
                    continue
                if not name.startswith(key + "-"):
                    warnings.append(
                        "%s/%s does not start with '%s-' — the gate will not find it"
                        % (folder, name, key)
                    )
                    continue
                page = parse_page(os.path.join(fpath, name), defaults)
                if page is None:
                    continue
                # grouping is orthogonal to locking: a vault page can sit under
                # any tab. Only the padlock says where it lives.
                if page["group"] not in group_ids:
                    if page["group"]:
                        warnings.append(
                            '%s/%s declares group "%s", which is not in catalogue.json'
                            % (folder, name, page["group"]))
                    page["group"] = vault_group
                page["tone"] = page["tone"] or group_tone.get(page["group"], "constructive")
                page["locked"] = True
                page["page"] = page["stem"]
                page["owner"] = key
                page["cta"] = page["cta"] if page["_annotated"] else "Unlock"
                sites.append(page)
    else:
        warnings.append(
            "vault repo not found at %s — locked pages left out of this build" % vault_dir
        )

    for s in sites:
        s.pop("stem", None)
        s.pop("_annotated", None)

    order_of = {g["id"]: g.get("order", 99) for g in cfg["groups"]}
    sites.sort(key=lambda s: (order_of.get(s["group"], 99), s["order"], s["title"].lower()))
    return sites, warnings


def render(cfg, sites):
    groups = [
        {"id": g["id"], "label": g["label"], "tone": g["tone"]}
        for g in sorted(cfg["groups"], key=lambda g: g.get("order", 99))
    ]
    payload = {"gate": cfg["gate_url"], "groups": groups, "sites": sites}
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    return (
        "/* GENERATED by tools/catalogue.py — do not edit by hand.\n"
        " * Add or change a page's <head> metadata, then run:\n"
        " *   python3 tools/catalogue.py\n"
        " */\n"
        "window.CATALOGUE = " + body + ";\n"
    )


def main():
    args = sys.argv[1:]
    with open(CONFIG, encoding="utf-8") as fh:
        cfg = json.load(fh)

    sites, warnings = collect(cfg)
    out = render(cfg, sites)

    if "--list" in args:
        for g in cfg["groups"]:
            rows = [s for s in sites if s["group"] == g["id"]]
            if not rows:
                continue
            print("\n%s (%d)" % (g["label"], len(rows)))
            for s in rows:
                lock = "🔒 " if s.get("locked") else "   "
                print("  %s%-26s %s" % (lock, s["title"], s.get("href") or "#" + s["page"]))
        print()

    for w in warnings:
        print("  warning: " + w, file=sys.stderr)

    if "--check" in args:
        current = open(OUTPUT, encoding="utf-8").read() if os.path.exists(OUTPUT) else ""
        if current != out:
            print("catalogue.js is out of date — run: python3 tools/catalogue.py", file=sys.stderr)
            return 1
        print("catalogue.js is up to date (%d pages)" % len(sites))
        return 0

    if "--list" in args:
        return 0

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as fh:
        fh.write(out)

    locked = sum(1 for s in sites if s.get("locked"))
    print("catalogue.js: %d pages (%d public, %d locked)" % (len(sites), len(sites) - locked, locked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
