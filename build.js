const builder = require('electron-builder');

builder.build({
  targets: builder.Platform.WINDOWS.createTarget('portable'),
  config: {
    appId: 'com.ac27.level-editor',
    productName: 'AC27 Level Editor',
    directories: { output: 'dist' },
    files: ['main.js', 'preload.js', 'src/**/*', 'node_modules/**/*'],
    win: {
      target: 'portable',
      icon: 'icon.ico',
      artifactName: '${productName}.${ext}'
    }
  }
}).then((result) => {
  console.log('BUILD SUCCESS!');
  console.log(JSON.stringify(result, null, 2));
}).catch((err) => {
  console.error('BUILD FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
