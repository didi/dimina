import { appTasks } from '@ohos/hvigor-ohos-plugin';
import { hvigor } from '@ohos/hvigor';
import fs from 'fs';
import path from 'path';

const sharedMiniPrograms = path.resolve(__dirname, '../../../shared/jsapp');
const harmonyMiniPrograms = path.resolve(
  __dirname,
  './entry/src/main/resources/rawfile/jsapp'
);

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  fs.readdirSync(source).forEach((name: string): void => {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    if (fs.statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  });
}

hvigor.nodesEvaluated((): void => {
  if (!fs.existsSync(sharedMiniPrograms)) {
    throw new Error(`Dimina shared jsapp directory not found: ${sharedMiniPrograms}`);
  }
  copyDirectory(sharedMiniPrograms, harmonyMiniPrograms);
});

export default {
  system: appTasks,
  plugins: []
}
