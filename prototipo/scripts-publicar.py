"""Convierte dist/index.html (documento completo) en el fragmento que espera la publicación como Artifact."""
import re, sys
src = open("dist/index.html", encoding="utf-8").read()
head = re.search(r"<head>(.*?)</head>", src, re.S).group(1)
body = re.search(r"<body>(.*?)</body>", src, re.S).group(1)
scripts = re.findall(r"<script\b[^>]*>.*?</script>", head, re.S)
for sc in scripts:
    head = head.replace(sc, "")
head = re.sub(r'<meta charset="UTF-8"\s*/?>', "", head)
head = re.sub(r'<meta name="viewport"[^>]*>', "", head)
title = re.search(r"<title>.*?</title>", head, re.S).group(0)
head = head.replace(title, "")
out = title + "\n" + head.strip() + "\n" + body.strip() + "\n" + "\n".join(s.replace(" crossorigin", "") for s in scripts) + "\n"
open(sys.argv[1], "w", encoding="utf-8").write(out)
print(len(out), "bytes; title at", out.find("<title>"))
