#!/usr/bin/env bash
# Jalankan kanban: muat .env, cek node >= 22, start server.js
cd "$(dirname "$0")" || exit 1

if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    key=${line%%=*}
    val=${line#*=}
    val=${val%\"}
    val=${val#\"}
    export "$key=$val"
  done < .env
fi

# node.exe Windows butuh path Windows; node WSL pakai path biasa.
WSL=0
case "$(uname -r)" in *[mM]icrosoft*|*WSL*) WSL=1;; esac

NODE=${NODE:-node}
command -v "$NODE" >/dev/null 2>&1 || NODE="/mnt/c/Program Files/nodejs/node.exe"
command -v "$NODE" >/dev/null 2>&1 || { echo "node tidak ditemukan. Set NODE=/path/ke/node" >&2; exit 1; }

if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "butuh Node.js >= 22 (node:sqlite), sekarang $("$NODE" -v)" >&2
  exit 1
fi

DIR=$(pwd)
if [ $WSL = 1 ] && [[ $NODE != /*/node ]]; then
  DIR=$(pwd | sed -E 's#^/mnt/([a-z])#\U\1:#; s#/#\\#g')
fi

exec "$NODE" "$DIR/server.js"
