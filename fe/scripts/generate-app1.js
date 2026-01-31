#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// ===================== 依赖检查 =====================
function checkAndInstallArchiver() {
  try {
    require.resolve('archiver');
    console.log('✅ archiver 依赖已安装');
  } catch (err) {
    console.log(`⚠️ 正在安装 archiver...`);
    try {
      execSync('pnpm install archiver --save-dev', { stdio: 'inherit', cwd: path.resolve(__dirname, '../') });
    } catch (installErr) {
      console.error(`❌ archiver 安装失败，请手动执行：pnpm install archiver --save-dev`);
      process.exit(1);
    }
  }
}
checkAndInstallArchiver();
const archiver = require('archiver');

// ===================== 工具函数 =====================
/**
 * 安全读取配置
 * @param {string} configPath 配置文件路径
 * @returns {object} 配置对象（兜底appid）
 */
function safeReadConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      console.warn(`⚠️ 配置文件不存在：${configPath}`);
      return { appid: `unknown_${path.basename(path.dirname(configPath))}` }; // 兜底appid
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    if (!config.appid) {
      console.warn(`⚠️ 配置文件无appid：${configPath}，使用兜底appid`);
      config.appid = `unknown_${path.basename(path.dirname(configPath))}`;
    }
    return config;
  } catch (err) {
    console.error(`❌ 读取配置失败：${err.message}，使用兜底appid`);
    return { appid: `unknown_${path.basename(path.dirname(configPath))}` };
  }
}

/**
 * 压缩目录（保留main目录结构） + 详细调试日志
 * @param {string} sourceDir 源目录
 * @param {string} outputZipPath 输出ZIP路径
 * @returns {Promise<boolean>} 压缩是否成功
 */
async function zipDirectory(sourceDir, outputZipPath) {
  const mainDir = path.join(sourceDir, 'main');
  console.log(`[调试] 待压缩的main文件夹：${mainDir}`);
  console.log(`[调试] 压缩目标路径：${outputZipPath}`);

  if (!fs.existsSync(mainDir)) {
    console.error(`❌ 压缩失败：main文件夹不存在 ${mainDir}`);
    return false;
  }
  const files = fs.readdirSync(mainDir);
  if (files.length === 0) {
    console.error(`❌ 压缩失败：main文件夹为空 ${mainDir}`);
    return false;
  }

  return new Promise((resolve) => {
    try {
      const zipParentDir = path.dirname(outputZipPath);
      if (!fs.existsSync(zipParentDir)) {
        fs.mkdirSync(zipParentDir, { recursive: true });
        console.log(`[调试] 创建目标目录：${zipParentDir}`);
      }

      const output = fs.createWriteStream(outputZipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        console.log(`✅ 压缩完成，ZIP大小：${(archive.pointer() / 1024).toFixed(2)} KB`);
        resolve(true);
      });

      archive.on('error', (err) => {
        console.error(`❌ 压缩异常：${err.message}`);
        resolve(false);
      });

      archive.pipe(output);
      // 核心：显式指定ZIP内的目录名为'main'，消除冗余路径
      archive.directory(mainDir, 'main');
      archive.finalize();
    } catch (err) {
      console.error(`❌ 压缩初始化失败：${err.message}`);
      resolve(false);
    }
  });
}

/**
 * 创建/更新config.json（文件不存在时自动新建）
 * @param {string} configPath 配置文件路径
 * @param {object} miniProgramConfig 小程序配置（project.config.json内容）
 * @param {object} appJson app.json配置内容
 */
function updateConfigJsonFile(configPath, miniProgramConfig, appJson) {
  // 处理首页路径，保持原有逻辑
  const homePagePath = appJson.pages[0] ? appJson.pages[0] : "example/index";

  try {
    let existingConfig = { versionCode: 0 }; // 默认配置，文件不存在时使用

    // 检查文件是否存在，不存在则跳过读取，直接使用默认配置
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      existingConfig = JSON.parse(content); // 读取并解析已有配置
    }

    // 构建新的配置对象
    let config = {
      appId: miniProgramConfig.appid || miniProgramConfig.appId || 'unknown',
      name: miniProgramConfig.projectname || miniProgramConfig.projectName || "小程序",
      path: homePagePath,
      versionCode: (existingConfig.versionCode || 1) + 1,
      versionName: miniProgramConfig.libVersion || "1.0.0"
    };

    // 递增版本号的最后一位（如 1.0.0 → 1.0.1）
    const versionParts = (config.versionName || "1.0.0").split('.');
    versionParts[versionParts.length - 1] = (Number.parseInt(versionParts[versionParts.length - 1], 10) + 1).toString();
    config.versionName = versionParts.join('.');

    console.log(`[调试] 读取原有config.json（文件不存在则使用默认值），versionCode递增为：${config.versionCode}`);

    // 确保配置文件所在目录存在
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      console.log(`[调试] 创建config.json所在目录：${configDir}`);
    }

    // 写入配置文件（文件不存在会自动新建，存在则覆盖）
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`✅ config.json更新/新建成功：${configPath}`);
    console.log(`[调试] 最新配置：`, config);

  } catch (err) {
    // 区分不同错误类型，给出更精准的提示
    if (err.code === 'ENOENT') {
      console.error(`❌ 找不到config.json所在目录：${err.path}`);
    } else if (err instanceof SyntaxError) {
      console.error(`❌ config.json文件格式错误，无法解析JSON：${err.message}`);
    } else {
      console.error(`❌ 更新/新建config.json失败：${err.message}`);
    }
  }
}

/**
 * 复制config.json到压缩包同级目录
 * @param {string} sourceConfigPath 源config.json路径
 * @param {string} targetDir 目标目录
 * @returns {boolean} 复制是否成功
 */
function copyConfigToZipDir(sourceConfigPath, targetDir) {
  try {
    if (!fs.existsSync(sourceConfigPath)) {
      console.error(`❌ 复制失败：源config.json不存在 ${sourceConfigPath}`);
      return false;
    }

    const targetConfigPath = path.join(targetDir, 'config.json');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      console.log(`[调试] 创建目标配置目录：${targetDir}`);
    }

    fs.copyFileSync(sourceConfigPath, targetConfigPath);
    console.log(`✅ config.json复制成功：${sourceConfigPath} → ${targetConfigPath}`);
    return true;
  } catch (err) {
    console.error(`❌ 复制config.json失败：${err.message}`);
    return false;
  }
}

// ===================== 配置项（核心修改：调整编译目录的绝对路径） =====================
const miniProgramPackagePath = path.resolve(__dirname, '../../shared/jsapp'); // 小程序打包路径
const miniProgramInstancePath = path.resolve(__dirname, '../example'); // 小程序实例路径
const compileDirName = 'dd编译'; // 编译目录名
// 编译目录的绝对路径（提至项目根目录，不再嵌套在小程序目录名下）
const compileDirAbsPath = path.resolve(__dirname, `../${compileDirName}`);
// 修改编译命令：-s 参数指向根目录的dd编译目录（不再用../../相对路径）
const compileCommand = `dmcc build -s ${compileDirAbsPath}`;
const miniProgramConfigFileName = 'project.config.json'; // 小程序配置文件名称

// ===================== 前置检查 =====================
if (!fs.existsSync(miniProgramPackagePath)) {
  console.error(`错误：打包目录不存在 ${miniProgramPackagePath}`);
  process.exit(1);
}
if (!fs.existsSync(miniProgramInstancePath)) {
  console.error(`错误：小程序实例目录不存在 ${miniProgramInstancePath}`);
  process.exit(1);
}
// 提前创建独立的dd编译目录（避免编译时目录不存在）
if (!fs.existsSync(compileDirAbsPath)) {
  fs.mkdirSync(compileDirAbsPath, { recursive: true });
  console.log(`[调试] 创建独立的编译目录：${compileDirAbsPath}`);
}

// ===================== 主流程 =====================
async function main() {
  console.log(`===== 开始处理（调试模式）=====`);
  console.log(`编译命令：${compileCommand}`);
  console.log(`[调试] 独立编译目录：${compileDirAbsPath}`);

  // 1. 获取小程序目录列表
  const miniProgramDirList = fs.readdirSync(miniProgramInstancePath)
    .filter(item => fs.statSync(path.join(miniProgramInstancePath, item)).isDirectory());

  if (miniProgramDirList.length === 0) {
    console.log(`⚠️ 无小程序目录`);
    return;
  }

  // 2. 编译所有小程序（编译输出到独立的dd编译目录）
  for (const miniProgramDirName of miniProgramDirList) {
    const miniProgramFullPath = path.join(miniProgramInstancePath, miniProgramDirName);
    console.log(`\n--- 编译【${miniProgramDirName}】---`);
    try {
      // 编译命令的cwd仍为小程序目录名（保证dmcc build读取该目录下的配置）
      execSync(compileCommand, { cwd: miniProgramFullPath, stdio: 'inherit' });
      console.log(`✅ 编译成功（产物输出到：${compileDirAbsPath}）`);
    } catch (err) {
      console.error(`❌ 编译失败：${err.message}`);
    }
  }

  // 3. 压缩所有产物 + 更新+复制config.json
  console.log(`\n--- 开始压缩所有产物（保留main目录结构）---`);
  for (const miniProgramDirName of miniProgramDirList) {
    const miniProgramFullPath = path.join(miniProgramInstancePath, miniProgramDirName);

    const configFilePath = path.join(miniProgramFullPath, miniProgramConfigFileName);
    const appJson = safeReadConfig(path.join(miniProgramFullPath, 'app.json'));

    console.log(`\n处理【${miniProgramDirName}】`);
    const miniProgramConfig = safeReadConfig(configFilePath);
    const miniProgramAppId = miniProgramConfig.appid;

    console.log(`[调试] appid：${miniProgramAppId}`);

    // ========== 核心修改：产物目录改为「独立dd编译目录 + appid」 ==========
    const miniProgramDistDir = path.join(compileDirAbsPath, miniProgramAppId);
    console.log(`[调试] 小程序编译后的产物目录：${miniProgramDistDir}`);

    // 拼接压缩路径（不变）
    const zipOutputPath = path.join(miniProgramPackagePath, miniProgramAppId, `${miniProgramAppId}.zip`);
    const zipDir = path.dirname(zipOutputPath);
    // 执行压缩
    const isZipSuccess = await zipDirectory(miniProgramDistDir, zipOutputPath);

    if (isZipSuccess) {
      console.log(`✅ 【${miniProgramDirName}】压缩完成，ZIP路径：${zipOutputPath}`);
      // 更新/创建config.json（在产物目录下）
      const localConfigPath = path.join(miniProgramDistDir, 'config.json');
      updateConfigJsonFile(localConfigPath, miniProgramConfig, appJson);
      // 复制config.json到压缩包同级目录
      copyConfigToZipDir(localConfigPath, zipDir);
    } else {
      console.error(`❌ 【${miniProgramDirName}】压缩失败，跳过config.json更新/复制`);
    }
  }

  console.log(`\n===== 所有流程结束 =====`);
}

// 执行主流程
main().catch(err => {
  console.error(`❌ 脚本异常：${err.message}`);
  process.exit(1);
});