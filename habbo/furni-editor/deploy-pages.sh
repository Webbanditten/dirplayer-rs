#!/bin/sh
# Publish the furni editor on the fork's GitHub Pages: https://webbanditten.github.io/dirplayer-rs/furni-editor/
#
#   habbo/furni-editor/deploy-pages.sh            # release build of the VM + the editor, then push
#   SKIP_VM=1 habbo/furni-editor/deploy-pages.sh  # vm-rust/pkg is already a release build
#
# The built site (only the editor's own files; casts are loaded from the asset host at runtime) is force-pushed as a
# single commit to the branch gh-pages, which Pages serves from its root. REMOTE overrides where it goes.
set -e
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
[ -n "$SKIP_VM" ] || npm run build-vm
npx vite build -c habbo/furni-editor/vite.config.js
site=$(mktemp -d)
mkdir -p "$site/furni-editor"
cp -R habbo/furni-editor/dist/. "$site/furni-editor/"
cat > "$site/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>DirPlayer tools</title>
<meta http-equiv="refresh" content="0; url=furni-editor/">
<a href="furni-editor/">Furni editor</a>
HTML
touch "$site/.nojekyll"
rev=$(git rev-parse --short HEAD)
remote=${REMOTE:-https://github.com/Webbanditten/dirplayer-rs.git}
cd "$site"
git init -q -b gh-pages
git add -A
git commit -q -m "Furni editor at $rev (built by habbo/furni-editor/deploy-pages.sh)"
case "$remote" in
  https://*) git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -q --force "$remote" gh-pages ;;
  *) git push -q --force "$remote" gh-pages ;;
esac
echo "Pushed $rev to gh-pages of $remote"
rm -rf "$site"
