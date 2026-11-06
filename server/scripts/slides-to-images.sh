#!/usr/bin/env bash
# Export every slide/page of a presentation or PDF to JPEG images.
#
#   bash slides-to-images.sh INPUT OUT_DIR [MAX_PAGES=30] [WIDTH=1280]
#
# INPUT: .ppt .pptx .pps .ppsx .odp .key .pdf (and .doc/.docx/.odt via LibreOffice)
# Writes OUT_DIR/document.pdf, OUT_DIR/slide-001.jpg, slide-002.jpg, ... and OUT_DIR/text.txt (page texts separated
# by form feeds, when pdftotext is available); prints the image count.
# Requires LibreOffice (soffice) for non-PDF input and poppler-utils (pdftoppm).
set -euo pipefail

in="${1:?用法: slides-to-images.sh INPUT OUT_DIR [MAX_PAGES] [WIDTH]}"
out="${2:?缺少输出目录}"
max="${3:-30}"
width="${4:-1280}"

[ -f "$in" ] || { echo "文件不存在：$in" >&2; exit 2; }
command -v pdftoppm >/dev/null || { echo "缺少 pdftoppm（请安装 poppler-utils）" >&2; exit 3; }
mkdir -p "$out"

ext="${in##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
if [ "$ext" = pdf ]; then
  cp "$in" "$out/document.pdf"
else
  soffice_bin="$(command -v soffice || command -v libreoffice || true)"
  [ -n "$soffice_bin" ] || { echo "缺少 LibreOffice（soffice），无法转换 .$ext 文件" >&2; exit 3; }
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  # A private profile per run lets several conversions run concurrently.
  cp "$in" "$work/input.$ext"
  timeout 180 "$soffice_bin" --headless --norestore --nolockcheck \
    "-env:UserInstallation=file://$work/profile" \
    --convert-to pdf --outdir "$work" "$work/input.$ext" >/dev/null 2>&1 || true
  [ -s "$work/input.pdf" ] || { echo "LibreOffice 转换失败：$in" >&2; exit 4; }
  mv "$work/input.pdf" "$out/document.pdf"
fi

rm -f "$out"/slide-*.jpg
pdftoppm -jpeg -jpegopt quality=82 -scale-to-x "$width" -scale-to-y -1 -f 1 -l "$max" "$out/document.pdf" "$out/slide"
# pdftoppm pads page numbers by the document's page count; normalise to slide-001.jpg.
n=0
while IFS= read -r f; do
  n=$((n + 1))
  target="$(printf '%s/slide-%03d.jpg' "$out" "$n")"
  [ "$f" = "$target" ] || mv "$f" "$target"
done < <(find "$out" -maxdepth 1 -name 'slide-*.jpg' | sort -V)
if command -v pdftotext >/dev/null; then
  pdftotext -layout -enc UTF-8 -f 1 -l "$max" "$out/document.pdf" "$out/text.txt" 2>/dev/null || true
fi
echo "$n"
