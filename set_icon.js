const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');
const { rcedit } = require('rcedit');

async function main() {
  const pngPath = path.join(__dirname, 'icon.png');
  const icoPath = path.join(__dirname, 'icon.ico');
  const exePath = process.argv[2] || path.join(__dirname, 'dist', 'AC27 Editor.exe');

  // 1. Convert PNG to ICO with multiple sizes
  console.log('Converting icon.png to icon.ico...');
  const buf = await pngToIco(pngPath, [256, 128, 64, 48, 32, 16]);
  fs.writeFileSync(icoPath, buf);
  const icoSize = fs.statSync(icoPath).size;
  console.log(`icon.ico created: ${Math.round(icoSize / 1024)} KB`);

  // 2. Embed ICO into the built exe using rcedit
  console.log('Embedding icon into ' + exePath + '...');
  await rcedit(exePath, { icon: icoPath });
  console.log('Icon embedded successfully!');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
