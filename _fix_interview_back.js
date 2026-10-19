const fs = require('fs');
const path = require('path');
const root = __dirname;
let n = 0;
fs.readdirSync(root).forEach(function (f) {
  if (!/^interviews-\d{4}\.html$/.test(f)) return;
  const p = path.join(root, f);
  let t = fs.readFileSync(p, 'utf8');
  const next = t.replace(
    '<a class="back" href="interviews.html">← Назад</a>',
    '<a class="back" href="interviews.html">← Все интервью</a>'
  );
  if (next !== t) {
    fs.writeFileSync(p, next);
    n++;
  }
});
console.log(n);
