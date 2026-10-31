#!/usr/bin/env python3
"""Antes de cada commit: python3 bump.py. Pone una versión nueva en index.html, version.json y sw.js."""
import re, json, datetime
v = datetime.datetime.now().strftime('%Y.%m.%d-%H%M')
for f, pat, rep in [('index.html', r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{v}';"), ('sw.js', r"const V = '[^']*';", f"const V = 'seg-{v}';")]:
    s = open(f).read(); s2 = re.sub(pat, rep, s, count=1); assert s2 != s or rep in s, f; open(f, 'w').write(s2)
json.dump({'v': v}, open('version.json', 'w'))
print(v)
