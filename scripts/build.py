"""Genera dist/ a partir de src/kana.js sin toolchain de Node.

- dist/kana.mjs      copia ESM tal cual
- dist/kana.umd.js   la misma fuente sin `export`, envuelta en UMD (window.Kana)
"""
import re
from pathlib import Path

raiz = Path(__file__).resolve().parent.parent
src = (raiz / "src" / "kana.js").read_text(encoding="utf-8")
dist = raiz / "dist"
dist.mkdir(exist_ok=True)

(dist / "kana.mjs").write_text(src, encoding="utf-8", newline="\n")

nombres = re.findall(r"^export (?:class|function|const) (\w+)", src, flags=re.M)
cuerpo = re.sub(r"^export ", "", src, flags=re.M)
umd = (
    "(function (root, factory) {\n"
    "  if (typeof define === 'function' && define.amd) define([], factory);\n"
    "  else if (typeof module === 'object' && module.exports) module.exports = factory();\n"
    "  else root.Kana = factory();\n"
    "}(typeof self !== 'undefined' ? self : this, function () {\n"
    "'use strict';\n"
    + cuerpo
    + "\nreturn { " + ", ".join(nombres) + " };\n"
    "}));\n"
)
(dist / "kana.umd.js").write_text(umd, encoding="utf-8", newline="\n")
print("dist ok:", ", ".join(nombres))
