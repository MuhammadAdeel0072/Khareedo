#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
agent-browser set viewport 768 1024 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser eval "(() => {
  const slide = document.querySelector('.flex > .relative.min-w-0');
  const flex = slide?.parentElement;
  const wrap = flex?.parentElement;
  const gridItem = wrap?.parentElement;
  const cs = el => { const s = getComputedStyle(el); return {w: s.width, disp: s.display, basis: s.flexBasis, aspect: s.aspectRatio, minH: s.minHeight}; };
  return JSON.stringify({
    gridItem: gridItem ? {cls: gridItem.className.slice(0,50), ...cs(gridItem)} : null,
    wrap: wrap ? cs(wrap) : null,
    flex: flex ? cs(flex) : null,
    slide: slide ? cs(slide) : null,
    aspectDiv: slide?.firstElementChild ? cs(slide.firstElementChild) : null
  }, null, 1);
})()"
