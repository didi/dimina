#!/usr/bin/env node

const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')

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
		// 核心修正：显式指定ZIP内的目录名为'main'，消除冗余路径
		archive.directory(mainDir, 'main');
		archive.finalize();
	  } catch (err) {
		console.error(`❌ 压缩初始化失败：${err.message}`);
		resolve(false);
	  }
	});
  }
/**
 * 创建/更新config.json（压缩成功后执行）
 * @param {string} configPath config.json文件路径
 * @param {string} appId 小程序appid
 */
function updateConfigJson(configPath, appId,小程序名称,小程序版本) {
  try {
    // 1. 初始化默认配置
    let config = {
      "appId": appId,
      "name": 小程序名称?小程序名称:"小程序",
      "path": "example/index",
      "versionCode": 1,
      "versionName": 小程序版本?小程序版本:"1.0.0"
    };

    // 2. 如果文件存在，读取并递增版本号
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const existingConfig = JSON.parse(content);
      // 保留原有name/path（如果有），仅更新appId、递增版本号
      config = {
        ...existingConfig,
        appId: appId, // 确保appId正确更新
        name: 小程序名称?小程序名称:"小程序", // 确保name正确更新
        versionCode: (existingConfig.versionCode || 1) + 1, // 递增versionCode
      };
      // 递增versionName最后一位（如1.0.1 → 1.0.2）
      const versionParts = (config.versionName || "1.0.0").split('.');
      versionParts[versionParts.length - 1] = (Number.parseInt(versionParts[versionParts.length - 1]) + 1).toString();
      config.versionName = versionParts.join('.');
      console.log(`[调试] 读取原有config.json，versionCode递增为：${config.versionCode}`);
    } else {
      console.log(`[调试] config.json不存在，创建新文件并初始化版本号`);
    }

    // 3. 写入config.json（格式化输出，便于阅读）
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log(`✅ config.json更新成功：${configPath}`);
    console.log(`[调试] 最新配置：`, config);
  } catch (err) {
    console.error(`❌ 更新config.json失败：${err.message}`);
  }
}

/**
 * 复制config.json到压缩包同级目录（覆盖已有文件）
 * @param {string} sourceConfigPath 源config.json路径（产物目录下）
 * @param {string} targetDir 目标目录（压缩包所在目录）
 */
function copyConfigToZipDir(sourceConfigPath, targetDir) {
  try {
    // 1. 检查源config.json是否存在
    if (!fs.existsSync(sourceConfigPath)) {
      console.error(`❌ 复制失败：源config.json不存在 ${sourceConfigPath}`);
      return false;
    }

    // 2. 拼接目标config.json路径（压缩包同目录，仅为config.json）
    const targetConfigPath = path.join(targetDir, 'config.json');
    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      console.log(`[调试] 创建目标配置目录：${targetDir}`);
    }

    // 3. 复制文件（覆盖已有文件，fs.copyFileSync默认覆盖）
    fs.copyFileSync(sourceConfigPath, targetConfigPath);
    console.log(`✅ config.json复制成功：${sourceConfigPath} → ${targetConfigPath}`);
    return true;
  } catch (err) {
    console.error(`❌ 复制config.json失败：${err.message}`);
    return false;
  }
}

// ===================== 配置项 =====================
const 小程序打包路径 = path.resolve(__dirname, '../../shared/jsapp');
const 小程序实例路径 = path.resolve(__dirname, '../example');
const 编译目录 = 'dd编译';
const 编译命令 = `dmcc build -s ./${编译目录}`;
const 小程序配置文件名称 = 'project.config.json';

// ===================== 前置检查 =====================
if (!fs.existsSync(小程序打包路径)) {
  console.error(`错误：打包目录不存在 ${小程序打包路径}`);
  process.exit(1);
}
if (!fs.existsSync(小程序实例路径)) {
  console.error(`错误：小程序实例目录不存在 ${小程序实例路径}`);
  process.exit(1);
}

// ===================== 主流程 =====================
async function main() {
  console.log(`===== 开始处理（调试模式）=====`);
  console.log(`编译命令：${编译命令}`);

  // 1. 获取小程序目录列表
  const 小程序目录列表 = fs.readdirSync(小程序实例路径)
    .filter(item => fs.statSync(path.join(小程序实例路径, item)).isDirectory());

  if (小程序目录列表.length === 0) {
    console.log(`⚠️ 无小程序目录`);
    return;
  }

  // 2. 编译所有小程序
  for (const 小程序目录名 of 小程序目录列表) {
    const 小程序完整路径 = path.join(小程序实例路径, 小程序目录名);
    console.log(`\n--- 编译【${小程序目录名}】---`);
    try {
      execSync(编译命令, { cwd: 小程序完整路径, stdio: 'inherit' });
      console.log(`✅ 编译成功`);
    } catch (err) {
      console.error(`❌ 编译失败：${err.message}`);
    }
  }

  // 3. 压缩所有产物 + 更新+复制config.json
  console.log(`\n--- 开始压缩所有产物（保留main目录结构）---`);
  for (const 小程序目录名 of 小程序目录列表) {
    const 小程序完整路径 = path.join(小程序实例路径, 小程序目录名);
    const 配置文件路径 = path.join(小程序完整路径, 小程序配置文件名称);

    console.log(`\n处理【${小程序目录名}】`);
    // 读取配置（带兜底）
    const 小程序配置 = safeReadConfig(配置文件路径);
    const 小程序appid = 小程序配置.appid;
	const 小程序名称 = 小程序配置.projectname;
	const 小程序版本 = 小程序配置.libVersion;
    console.log(`[调试] appid：${小程序appid}`);

    const 小程序产物目录 = path.join(小程序完整路径, 编译目录, 小程序appid);
    // 拼接压缩路径
    const zipOutputPath = path.join(小程序打包路径, 小程序appid, `${小程序appid}.zip`);
    // 压缩包所在目录（用于复制config.json）
    const zipDir = path.dirname(zipOutputPath);
    // 执行压缩（保留main目录结构）
    const 压缩成功 = await zipDirectory(小程序产物目录, zipOutputPath);

    if (压缩成功) {
      console.log(`✅ 【${小程序目录名}】压缩完成，ZIP路径：${zipOutputPath}`);
      // 步骤1：更新/创建产物目录下的config.json
      const localConfigPath = path.join(小程序产物目录, 'config.json');
      updateConfigJson(localConfigPath, 小程序appid,小程序名称,小程序版本);

      // 步骤2：复制config.json到压缩包同级目录（仅为config.json，覆盖已有）
      copyConfigToZipDir(localConfigPath, zipDir);
    } else {
      console.error(`❌ 【${小程序目录名}】压缩失败，跳过config.json更新/复制`);
    }
  }

  console.log(`\n===== 所有流程结束 =====`);
}

// 执行主流程
main().catch(err => {
  console.error(`❌ 脚本异常：${err.message}`);
  process.exit(1);
});