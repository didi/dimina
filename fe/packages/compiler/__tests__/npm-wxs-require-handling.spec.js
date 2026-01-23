import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import MagicString from 'magic-string'

// 模拟 transTagWxs 函数中处理 wxs 内部 require 的逻辑
function mockProcessWxsRequires(wxsContent, wxsFilePath, filePath, workPath) {
	const scriptModule = []
	
	const wxsAst = parseSync(wxsFilePath, wxsContent, { sourceType: 'module' })
	const s = new MagicString(wxsContent)
	const transforms = []
	
	walk(wxsAst.program, {
		enter(node) {
			if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
				// getRegExp -> new RegExp, getDate -> new Date
				if (node.callee.name === 'getRegExp' || node.callee.name === 'getDate') {
					const argsCode = node.arguments.map(arg => 
						wxsContent.slice(arg.start, arg.end)
					).join(', ')
					
					const className = node.callee.name.substring(3) // 'RegExp' or 'Date'
					transforms.push({
						start: node.start,
						end: node.end,
						replacement: `new ${className}(${argsCode})`
					})
				}
				// 处理 wxs 文件内部的 require 调用
				else if (node.callee.name === 'require' && node.arguments.length > 0) {
					const firstArg = node.arguments[0]
					if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
						const requirePath = firstArg.value
						
						if (requirePath) {
							// 解析 wxs 内部的相对路径 require
							let resolvedWxsPath
							
							if (filePath.includes('/miniprogram_npm/')) {
								// 对于 npm 组件中的 wxs，需要特殊处理相对路径
								const currentWxsDir = path.dirname(wxsFilePath)
								resolvedWxsPath = path.resolve(currentWxsDir, requirePath)
								
								// 转换为相对于工作目录的路径，并移除 .wxs 扩展名
								const relativePath = resolvedWxsPath.replace(workPath, '').replace(/\.wxs$/, '')
								
								// 生成唯一的模块名（移除特殊字符）
								const moduleName = relativePath.replace(/[\/\\@\-]/g, '_').replace(/^_/, '')
								
								// 将依赖的 wxs 文件也加入到 scriptModule 中
								if (fs.existsSync(resolvedWxsPath)) {
									const depWxsContent = fs.readFileSync(resolvedWxsPath, 'utf-8').trim()
									if (depWxsContent && !scriptModule.find(sm => sm.path === moduleName)) {
										// 递归处理依赖的 wxs 文件
										const depWxsAst = parseSync(resolvedWxsPath, depWxsContent, { sourceType: 'module' })
										const depS = new MagicString(depWxsContent)
										const depTransforms = []
										
										// 对依赖文件也进行 getRegExp/getDate 转换
										walk(depWxsAst.program, {
											enter(depNode) {
												if (depNode.type === 'CallExpression' && depNode.callee.type === 'Identifier') {
													if (depNode.callee.name === 'getRegExp' || depNode.callee.name === 'getDate') {
														const depArgsCode = depNode.arguments.map(arg => 
															depWxsContent.slice(arg.start, arg.end)
														).join(', ')
														
														const depClassName = depNode.callee.name.substring(3)
														depTransforms.push({
															start: depNode.start,
															end: depNode.end,
															replacement: `new ${depClassName}(${depArgsCode})`
														})
													}
												}
											}
										})
										
										// 应用转换
										depTransforms.sort((a, b) => b.start - a.start)
										for (const t of depTransforms) {
											depS.overwrite(t.start, t.end, t.replacement)
										}
										
										const depWxsCode = depS.toString()
										
										scriptModule.push({
											path: moduleName,
											code: depWxsCode,
										})
									}
								}
								
								// 替换 require 路径
								transforms.push({
									start: firstArg.start,
									end: firstArg.end,
									replacement: `"${moduleName}"`
								})
							}
						}
					}
				}
			}
		}
	})
	
	// 应用转换（从后往前避免位置偏移）
	transforms.sort((a, b) => b.start - a.start)
	for (const t of transforms) {
		s.overwrite(t.start, t.end, t.replacement)
	}
	
	const transformedCode = s.toString()
	
	return {
		transformedCode,
		scriptModule
	}
}

describe('npm 组件 wxs 内部 require 处理', () => {
	let tempDir
	let workPath

	beforeEach(() => {
		// 创建临时目录
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-wxs-require-test-'))
		workPath = tempDir
		
		// 创建 npm 组件目录结构
		const npmComponentDir = path.join(tempDir, 'miniprogram_npm/@vant/weapp')
		fs.mkdirSync(npmComponentDir, { recursive: true })
		
		// 创建 wxs 目录和文件
		const wxsDir = path.join(npmComponentDir, 'wxs')
		fs.mkdirSync(wxsDir, { recursive: true })
		
		// 创建 bem.wxs
		fs.writeFileSync(path.join(wxsDir, 'bem.wxs'), `
function bem(name, mods) {
  return name + (mods ? '--' + mods : '');
}
module.exports = bem;
		`.trim())
		
		// 创建 memoize.wxs
		fs.writeFileSync(path.join(wxsDir, 'memoize.wxs'), `
function memoize(fn) {
  return fn;
}
module.exports = memoize;
		`.trim())
		
		// 创建 add-unit.wxs
		fs.writeFileSync(path.join(wxsDir, 'add-unit.wxs'), `
function addUnit(value) {
  return value + 'px';
}
module.exports = addUnit;
		`.trim())
		
		// 创建 utils.wxs（包含多个 require）
		fs.writeFileSync(path.join(wxsDir, 'utils.wxs'), `
var bem = require('./bem.wxs');
var memoize = require('./memoize.wxs');
var addUnit = require('./add-unit.wxs');

module.exports = {
  bem: memoize(bem),
  memoize: memoize,
  addUnit: addUnit
};
		`.trim())
	})

	afterEach(() => {
		// 清理临时目录
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('应该正确处理 wxs 文件内部的 require 调用', () => {
		const filePath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsFilePath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/utils.wxs')
		const wxsContent = fs.readFileSync(wxsFilePath, 'utf-8')
		
		const result = mockProcessWxsRequires(wxsContent, wxsFilePath, filePath, workPath)
		
		// 检查转换后的代码是否包含正确的模块名
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_bem")')
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_memoize")')
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_add_unit")')
		
		// 检查是否正确添加了依赖模块
		expect(result.scriptModule).toHaveLength(3)
		expect(result.scriptModule.find(sm => sm.path === 'miniprogram_npm__vant_weapp_wxs_bem')).toBeDefined()
		expect(result.scriptModule.find(sm => sm.path === 'miniprogram_npm__vant_weapp_wxs_memoize')).toBeDefined()
		expect(result.scriptModule.find(sm => sm.path === 'miniprogram_npm__vant_weapp_wxs_add_unit')).toBeDefined()
	})

	it('应该正确处理单个 require 调用', () => {
		// 创建一个简单的 wxs 文件
		const simpleWxsPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/radio/index.wxs')
		fs.mkdirSync(path.dirname(simpleWxsPath), { recursive: true })
		fs.writeFileSync(simpleWxsPath, `
var utils = require('../wxs/utils.wxs');
module.exports = { computed: utils.bem };
		`.trim())
		
		const filePath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsContent = fs.readFileSync(simpleWxsPath, 'utf-8')
		
		const result = mockProcessWxsRequires(wxsContent, simpleWxsPath, filePath, workPath)
		
		// 检查转换后的代码
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_utils")')
		
		// 检查是否添加了依赖模块
		expect(result.scriptModule).toHaveLength(1)
		expect(result.scriptModule[0].path).toBe('miniprogram_npm__vant_weapp_wxs_utils')
	})

	it('应该处理不存在的 wxs 文件', () => {
		const filePath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsFilePath = path.join(workPath, 'miniprogram_npm/@vant/weapp/radio/index.wxs')
		fs.mkdirSync(path.dirname(wxsFilePath), { recursive: true })
		
		// 创建引用不存在文件的 wxs
		const wxsContent = `
var nonExistent = require('./non-existent.wxs');
module.exports = { test: nonExistent };
		`.trim()
		
		fs.writeFileSync(wxsFilePath, wxsContent)
		
		const result = mockProcessWxsRequires(wxsContent, wxsFilePath, filePath, workPath)
		
		// 应该仍然转换路径，但不会添加到 scriptModule
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_radio_non_existent")')
		expect(result.scriptModule).toHaveLength(0)
	})

	it('应该跳过非 npm 组件的处理', () => {
		const filePath = '/components/custom/index'
		const wxsFilePath = path.join(workPath, 'components/custom/index.wxs')
		fs.mkdirSync(path.dirname(wxsFilePath), { recursive: true })
		
		const wxsContent = `
var helper = require('./helper.wxs');
module.exports = { test: helper };
		`.trim()
		
		fs.writeFileSync(wxsFilePath, wxsContent)
		
		const result = mockProcessWxsRequires(wxsContent, wxsFilePath, filePath, workPath)
		
		// 对于非 npm 组件，应该保持原样
		expect(result.transformedCode).toContain('./helper.wxs')
		expect(result.scriptModule).toHaveLength(0)
	})

	it('应该处理复杂的相对路径', () => {
		// 创建深层嵌套的组件
		const deepComponentDir = path.join(workPath, 'miniprogram_npm/@vant/weapp/calendar/components/month')
		fs.mkdirSync(deepComponentDir, { recursive: true })
		
		const wxsFilePath = path.join(deepComponentDir, 'index.wxs')
		const wxsContent = `
var utils = require('../../../wxs/utils.wxs');
module.exports = { computed: utils.bem };
		`.trim()
		
		fs.writeFileSync(wxsFilePath, wxsContent)
		
		const filePath = '/miniprogram_npm/@vant/weapp/calendar/components/month/index'
		const result = mockProcessWxsRequires(wxsContent, wxsFilePath, filePath, workPath)
		
		// 检查是否正确解析了复杂的相对路径
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_utils")')
		expect(result.scriptModule).toHaveLength(1)
	})

	it('应该在 npm wxs 依赖文件中正确转换 getRegExp 和 getDate', () => {
		// 创建包含 getRegExp 和 getDate 的 wxs 文件
		const regexHelperPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/regex-helper.wxs')
		fs.writeFileSync(regexHelperPath, `
// 使用 getRegExp 创建正则表达式
var EMAIL_REGEX = getRegExp('^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$');
var PHONE_REGEX = getRegExp('^1[3-9]\\d{9}$');

function validateEmail(email) {
  return EMAIL_REGEX.test(email);
}

function validatePhone(phone) {
  return PHONE_REGEX.test(phone);
}

module.exports = {
  validateEmail: validateEmail,
  validatePhone: validatePhone
};
		`.trim())

		const dateHelperPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/date-helper.wxs')
		fs.writeFileSync(dateHelperPath, `
// 使用 getDate 创建日期对象
function getCurrentYear() {
  var now = getDate();
  return now.getFullYear();
}

function formatTimestamp(timestamp) {
  var date = getDate(timestamp);
  return date.toISOString();
}

function isValidDate(year, month, day) {
  var date = getDate(year, month - 1, day);
  return date.getFullYear() === year && 
         date.getMonth() === month - 1 && 
         date.getDate() === day;
}

module.exports = {
  getCurrentYear: getCurrentYear,
  formatTimestamp: formatTimestamp,
  isValidDate: isValidDate
};
		`.trim())

		// 创建主 wxs 文件，引用包含 getRegExp/getDate 的文件
		const mainWxsPath = path.join(workPath, 'miniprogram_npm/@vant/weapp/wxs/validator.wxs')
		fs.writeFileSync(mainWxsPath, `
var regexHelper = require('./regex-helper.wxs');
var dateHelper = require('./date-helper.wxs');

function validateUserInfo(email, timestamp) {
  var emailValid = regexHelper.validateEmail(email);
  var currentYear = dateHelper.getCurrentYear();
  return emailValid && currentYear > 2020;
}

module.exports = {
  validateUserInfo: validateUserInfo
};
		`.trim())

		const filePath = '/miniprogram_npm/@vant/weapp/radio/index'
		const wxsContent = fs.readFileSync(mainWxsPath, 'utf-8')
		
		const result = mockProcessWxsRequires(wxsContent, mainWxsPath, filePath, workPath)
		
		// 验证主文件的 require 转换
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_regex_helper")')
		expect(result.transformedCode).toContain('require("miniprogram_npm__vant_weapp_wxs_date_helper")')
		
		// 验证依赖模块被正确添加
		expect(result.scriptModule).toHaveLength(2)
		
		const regexHelperModule = result.scriptModule.find(sm => sm.path === 'miniprogram_npm__vant_weapp_wxs_regex_helper')
		const dateHelperModule = result.scriptModule.find(sm => sm.path === 'miniprogram_npm__vant_weapp_wxs_date_helper')
		
		expect(regexHelperModule).toBeDefined()
		expect(dateHelperModule).toBeDefined()
		
		// 验证 getRegExp 被转换为 new RegExp
		expect(regexHelperModule.code).toContain('new RegExp')
		expect(regexHelperModule.code).not.toContain('getRegExp(')
		
		// 验证 getDate 被转换为 new Date
		expect(dateHelperModule.code).toContain('new Date')
		// 注意：date.getDate() 是 Date 对象的方法，不应该被转换
		// 只有直接调用 getDate() 的才会被转换为 new Date()
		
		// 验证具体的转换结果
		expect(regexHelperModule.code).toContain('new RegExp(\'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$\')')
		expect(regexHelperModule.code).toContain('new RegExp(\'^1[3-9]\\d{9}$\')')
		expect(dateHelperModule.code).toContain('new Date()')
		expect(dateHelperModule.code).toContain('new Date(timestamp)')
		expect(dateHelperModule.code).toContain('new Date(year, month - 1, day)')
	})
}) 