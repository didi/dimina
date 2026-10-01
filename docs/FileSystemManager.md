# FileSystemManager 本地文件缓存

Android、iOS、Harmony 支持在当前小程序的 `wx.env.USER_DATA_PATH` 下持久化文件。`getFileSystemManager()` 返回实例，以下方法既支持 `success / fail / complete` 回调，也支持不传回调时返回 Promise：

| 用途 | 异步方法 | 同步方法 |
| --- | --- | --- |
| 存在性检查 | access | accessSync |
| 创建目录 | mkdir | mkdirSync |
| 读写文件 | readFile / writeFile | readFileSync / writeFileSync |
| 删除文件 | unlink | unlinkSync |
| 遍历、查询 | readdir / stat | readdirSync / statSync |
| 删除目录 | rmdir | rmdirSync |
| 复制、重命名 | copyFile / rename | copyFileSync / renameSync |

`readFile` / `writeFile` 的文本缓存使用 `encoding: 'utf8'`。没有设置读取编码时，返回二进制 ArrayBuffer。这里使用原生文件系统，不经过 MMKV，也不受 Storage 单键大小限制；当前 SDK 没有为这条文件读写链路设置单文件或总量配额，实际可用空间由系统决定。业务应限制缓存数量，并处理空间不足等 `fail` / Promise rejection。

## 包内资源

`readFile` / `readFileSync` 和 `readCompressedFile` / `readCompressedFileSync` 也支持当前小程序的只读包内资源路径，例如 `/utils/libpag.wasm.br`。相对路径与前导 `/` 都相对于当前小程序包解析，不能越过包根目录；写入、删除等操作仍限制在用户和临时沙箱。`readCompressedFile` 的 `compressionAlgorithm` 当前支持 `br`，返回解压后的二进制 ArrayBuffer。Wasm 加载示例见 [WXWebAssembly](./WXWebAssembly.md)。

## Promise 缓存示例

```js
const fs = wx.getFileSystemManager()
const base = `${wx.env.USER_DATA_PATH}/form-cache`
const filePath = `${base}/app1_formA.json`

try {
  await fs.mkdir({ dirPath: base, recursive: true })
} catch (error) {
  // 已有目录可以复用；文件冲突、权限等错误继续交给上层处理。
  const { stats } = await fs.stat({ path: base }).catch(() => { throw error })
  if (!stats.isDirectory()) throw error
}

// 优先读取旧缓存；失败时可回退网络。
try {
  const { data } = await fs.readFile({ filePath, encoding: 'utf8' })
  renderForm(JSON.parse(data))
} catch (error) {
  // 缓存不存在、损坏或无法读取时，由业务执行网络回退。
}

// 获取新版本后保存；示例 formObject 来自业务请求结果。
await fs.writeFile({ filePath, data: JSON.stringify(formObject), encoding: 'utf8' })
```

## 回调用法

```js
fs.readFile({
  filePath,
  encoding: 'utf8',
  success: ({ data }) => renderForm(JSON.parse(data)),
  fail: error => fetchFormFromServer(),
})
```

传入回调时按回调方式处理结果，不同时依赖返回值为 Promise。`access` 的失败不一定代表目录不存在，也可能是路径无效或权限错误；`mkdir({ recursive: true })` 只负责创建缺失的父目录，目标已存在时仍失败；初始化方式见上面的示例。

## 持久化与清理

- 路径按 appId 隔离。关闭小程序不会清理 `USER_DATA_PATH`；卸载时保留或删除数据遵循 `clearUserData` 配置。
- `unlink` 只删除文件；`rmdir` 只删除目录。删除非空目录必须显式设置 `recursive: true`，避免误删整份缓存。
- `stat({ path, recursive: true })` 在目录上返回以相对路径为键的统计集合，根节点的键为 `""`，子节点为 `"/文件名"` 或 `"/目录/文件名"`；文件则返回单个统计对象；`mode` 为数字形式的 POSIX 类型与权限位，统计对象经 Service 转换后提供 `isFile()` 和 `isDirectory()`。
- 写入失败后，可调用 `unlink({ filePath: temporaryPath })` 清理业务自己创建的临时文件。清理失败也应单独处理，不覆盖原始写入错误。
- 不假定写入自动原子化，也不把 `writeFile` 当作数据库事务。并发写同一文件需由业务串行化。

本说明覆盖 #335 的文件缓存场景；`saveFile` 和 `openDocument` 的既有语义保持不变。

## 缓存接口兼容范围

以下行为覆盖 #335 使用的本地缓存链路，不代表整个 FileSystemManager 已完全兼容。

- `mkdir`：即使 `recursive: true`，已有目标仍报错。
- `copyFile`：源必须是文件；同一路径复制成功且保留内容；缺失源文件不能删除已有目标，目标目录不能被文件替换。
- `rename`：支持文件覆盖和目录重命名；用户文件根目录、临时文件根目录不能被删除或重命名，也不能作为替换目标。
- 递归 `stat` 的路径键、数字 `mode` 如上。

Dimina 尚未配置 SDK 文件配额；完整的编码、读取范围参数及错误文案兼容不在本次范围内。
