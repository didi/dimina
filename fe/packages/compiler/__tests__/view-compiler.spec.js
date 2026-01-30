import { describe, expect, it } from 'vitest'
import { generateVModelTemplate, generateSlotDirective, parseBraceExp, parseClassRules, parseKeyExpression, processWxsContent, splitWithBraces } from '../src/core/view-compiler'

describe('parseKeyExpression - 解析 key 表达式', () => {
	it('默认索引名 index - 应该直接返回 index', () => {
		expect(parseKeyExpression('index')).toEqual('index')
	})
	
	it('普通属性名 - 应该添加 item 前缀', () => {
		expect(parseKeyExpression('value')).toEqual('item.value')
	})
	
	it('已有 item 前缀的属性 - 应该保持不变', () => {
		expect(parseKeyExpression('item.index')).toEqual('item.index')
	})

	it('双花括号包裹的属性 - 应该去除花括号', () => {
		expect(parseKeyExpression('{{ item.index }}')).toEqual('item.index')
	})

	it('双花括号包裹的索引名 - 应该直接返回索引名', () => {
		expect(parseKeyExpression('{{ index }}')).toEqual('index')
	})

	it('双花括号包裹的简单属性 - 应该添加 item 前缀', () => {
		expect(parseKeyExpression('{{ text }}')).toEqual('item.text')
	})

	it('*this 关键字 - 应该转换为 toString 方法', () => {
		expect(parseKeyExpression('*this')).toEqual('item.toString()')
	})

	it('双花括号包裹的 this - 应该转换为 toString 方法', () => {
		expect(parseKeyExpression('{{ this }}')).toEqual('item.toString()')
	})
	
	it('正整数 - 应该直接返回数字', () => {
		expect(parseKeyExpression('1')).toEqual('1')
	})
	
	it('负整数 - 应该直接返回负数', () => {
		expect(parseKeyExpression('-1')).toEqual('-1')
	})
	
	it('正小数 - 应该直接返回小数', () => {
		expect(parseKeyExpression('3.14')).toEqual('3.14')
	})
	
	it('负小数 - 应该直接返回负小数', () => {
		expect(parseKeyExpression('-2.5')).toEqual('-2.5')
	})
	
	it('零 - 应该直接返回零', () => {
		expect(parseKeyExpression('0')).toEqual('0')
	})
	
	it('双花括号包裹的正整数 - 应该返回字符串形式', () => {
		expect(parseKeyExpression('{{ 1 }}')).toEqual('item.1')
	})
	
	it('双花括号包裹的负整数 - 应该返回字符串形式', () => {
		expect(parseKeyExpression('{{ -1 }}')).toEqual('item.-1')
	})
	
	it('字符串拼接表达式 - 应该正确处理拼接', () => {
		expect(parseKeyExpression('1-{{index}}')).toEqual('\'1-\'+index')
	})

	it('字符串拼接对象属性表达式 - 应该正确处理拼接', () => {
		expect(parseKeyExpression('1-{{item.index}}')).toEqual('\'1-\'+item.index')
	})
	
	it('自定义索引名 - 应该直接返回自定义索引名', () => {
		expect(parseKeyExpression('i', 'item', 'i')).toEqual('i')
	})
	
	it('自定义索引名在花括号中 - 应该直接返回自定义索引名', () => {
		expect(parseKeyExpression('{{ i }}', 'item', 'i')).toEqual('i')
	})
})

describe('parseBraceExp - 解析双花括号表达式', () => {
	it('纯文本字符串 - 应该包裹引号', () => {
		expect(parseBraceExp('item-container')).toEqual('\'item-container\'')
	})

	it('对象字面量表达式 - 应该去除外层花括号', () => {
		expect(parseBraceExp('{{text: \'I am template\'}}')).toEqual('text: \'I am template\'')
	})

	it('对象属性访问 - 应该去除花括号', () => {
		expect(parseBraceExp('{{item.name}}')).toEqual('item.name')
	})

	it('三层嵌套花括号 - 应该保留内层花括号', () => {
		expect(parseBraceExp('{{{item.name}}}')).toEqual('{item.name}')
	})

	it('三层嵌套对象属性 - 应该保留内层花括号', () => {
		expect(parseBraceExp('{{{background: \'transparent\'}}}')).toEqual(
			'{background: \'transparent\'}',
		)
	})

	it('混合文本和表达式 - 应该正确拼接', () => {
		expect(parseBraceExp('item-container item-container-{{index}}')).toEqual(
			'\'item-container item-container-\'+index',
		)
	})

	it('三元运算符表达式 - 应该用括号包裹', () => {
		expect(parseBraceExp('{{showReserveTime ? \'justify-content: space-between;\' : \'justify-content: flex-end;\'}}')).toEqual(
			'(showReserveTime ? \'justify-content: space-between;\' : \'justify-content: flex-end;\')',
		)
	})

	it('逻辑运算符表达式 - 应该保持原样', () => {
		expect(parseBraceExp('{{item.data.originFloor && item.data.originFloor.text || \'description\'}}')).toEqual(
			'item.data.originFloor && item.data.originFloor.text || \'description\'',
		)
	})

	it('URL 模板字符串 - 应该正确转义引号', () => {
		expect(parseBraceExp('background:url(\'{{imageList}}\')')).toEqual(
			'\'background:url(\\\'\'+imageList+\'\\\')\'',
		)
	})
})

describe('splitWithBraces - 按空格分割字符串（保留花括号）', () => {
	it('简单空格分割 - 应该返回数组', () => {
		expect(splitWithBraces('a b')).toEqual(['a', 'b'])
	})
	
	it('空格和花括号表达式 - 应该保持花括号完整', () => {
		expect(splitWithBraces('a {{b}}')).toEqual(['a', '{{b}}'])
	})
	
	it('连字符和花括号混合 - 应该作为一个整体', () => {
		expect(splitWithBraces('a b-{{c}}')).toEqual(['a', 'b-{{c}}'])
	})
	
	it('花括号紧跟文本 - 应该作为一个整体', () => {
		expect(splitWithBraces('a b{{c}}')).toEqual(['a', 'b{{c}}'])
	})
	
	it('花括号在文本中间 - 应该作为一个整体', () => {
		expect(splitWithBraces('a {{b}}c')).toEqual(['a', '{{b}}c'])
	})
	
	it('花括号内前置空格 - 应该保留空格', () => {
		expect(splitWithBraces('a b-{{ c}}')).toEqual(['a', 'b-{{ c}}'])
	})
	
	it('花括号内后置空格 - 应该保留空格', () => {
		expect(splitWithBraces('a b-{{c }}')).toEqual(['a', 'b-{{c }}'])
	})
	
	it('花括号内前后空格 - 应该保留所有空格', () => {
		expect(splitWithBraces('a b-{{ c }}')).toEqual(['a', 'b-{{ c }}'])
	})
})

describe('parseClassRules - 解析 CSS 类名规则', () => {
	it('纯文本类名 - 应该包裹引号', () => {
		expect(parseClassRules('item-container')).toEqual('\'item-container\'')
	})

	it('单个花括号表达式 - 应该去除花括号', () => {
		expect(parseClassRules('{{item-container}}')).toEqual('item-container')
	})

	it('多个类名和表达式混合 - 应该返回数组格式', () => {
		expect(
			parseClassRules('confirm-button {{disabled ? \'disabled\' : \'\'}} {{round ? \'round-button\' : \'\'}}'),
		).toEqual('[\'confirm-button\',(disabled ? \'disabled\' : \'\'),(round ? \'round-button\' : \'\')]')
	})

	it('文本和表达式拼接 - 应该返回数组格式', () => {
		expect(parseClassRules('item-container item-container-{{index}}')).toEqual(
			'[\'item-container\',\'item-container-\'+index]',
		)
	})
})

describe('generateVModelTemplate - 生成 v-model 模板', () => {
	it('逻辑与表达式 - 应该生成条件赋值', () => {
		expect(generateVModelTemplate('tempOffset && finalOffset')).to.equal(
			'tempOffset ? (finalOffset = $event) : (tempOffset = $event)',
		)
	})

	it('逻辑或表达式 - 应该生成条件赋值', () => {
		expect(generateVModelTemplate('tempOffset || finalOffset')).to.equal(
			'tempOffset ? (tempOffset = $event) : (finalOffset = $event)',
		)
	})

	it('三元表达式 - 应该生成条件赋值', () => {
		expect(generateVModelTemplate('tempOffset ? tempOffset : finalOffset')).to.equal(
			'tempOffset ? (tempOffset = $event) : (finalOffset = $event)',
		)
	})

	it('无效表达式 - 应该返回 false', () => {
		expect(generateVModelTemplate('invalidExpression')).to.equal(false)
	})

	it('带空格的表达式 - 应该正确处理', () => {
		expect(generateVModelTemplate('  tempOffset  &&  finalOffset  ')).to.equal(
			'tempOffset ? (finalOffset = $event) : (tempOffset = $event)',
		)
	})

	it('简短变量名 - 应该正确处理', () => {
		expect(generateVModelTemplate('a || b')).to.equal('a ? (a = $event) : (b = $event)')
	})
})

describe('processWxsContent - 处理 wxs 内容中的 getRegExp 转换', () => {
	it('应该转换字符串字面量参数的 getRegExp 调用', () => {
		const wxsContent = `
			function test() {
				var reg1 = getRegExp('(.+)MpxDash$');
				var reg2 = getRegExp('[$]', 'g');
				var reg3 = getRegExp('[A-Z]', 'g');
				return reg1;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证字符串字面量参数的 getRegExp 调用被转换为正则表达式字面量
		expect(result).toContain('/(.+)MpxDash$/')
		expect(result).toContain('/[$]/g')
		expect(result).toContain('/[A-Z]/g')
		expect(result).not.toContain('getRegExp(\'(.+)MpxDash$\')')
		expect(result).not.toContain('getRegExp(\'[$]\', \'g\')')
		expect(result).not.toContain('getRegExp(\'[A-Z]\', \'g\')')
	})

	it('应该转换变量参数的 getRegExp 调用为 new RegExp', () => {
		const wxsContent = `
			function genRegExp(str, flags) {
				return getRegExp(str, flags);
			}
			
			function test() {
				var pattern = '(.+)MpxDash$';
				var flags = 'g';
				return getRegExp(pattern, flags);
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证变量参数的 getRegExp 调用被转换为 new RegExp
		expect(result).toContain('new RegExp(str, flags)')
		expect(result).toContain('new RegExp(pattern, flags)')
		expect(result).not.toContain('getRegExp(str, flags)')
		expect(result).not.toContain('getRegExp(pattern, flags)')
	})

	it('应该正确处理复杂的正则表达式模式', () => {
		const wxsContent = `
			function test() {
				var reg1 = getRegExp(';(?![^(]*[)])', 'g');
				var reg2 = getRegExp(':(.+)');
				var reg3 = getRegExp('-([a-z])', 'g');
				return reg1;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证复杂正则表达式模式被正确转换
		expect(result).toContain('/;(?![^(]*[)])/g')
		expect(result).toContain('/:(.+)/')
		expect(result).toContain('/-([a-z])/g')
	})

	it('应该处理只有一个参数的 getRegExp 调用', () => {
		const wxsContent = `
			function test() {
				var reg = getRegExp('test');
				return reg;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证只有一个参数的调用被正确转换
		expect(result).toContain('/test/')
		expect(result).not.toContain('getRegExp(\'test\')')
	})

	it('应该处理 getDate 转换', () => {
		const wxsContent = `
			function test() {
				var date1 = getDate();
				var date2 = getDate(2023, 5, 15);
				return date1;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证 getDate 调用被转换为 new Date
		expect(result).toContain('new Date()')
		expect(result).toContain('new Date(2023, 5, 15)')
		expect(result).not.toContain('getDate()')
		expect(result).not.toContain('getDate(2023, 5, 15)')
	})

	it('应该处理 constructor 属性访问', () => {
		const wxsContent = `
			function test() {
				var arr = [];
				var type = arr.constructor;
				return type;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证 constructor 属性访问被转换为 Object.prototype.toString.call().slice(8, -1)
		expect(result).toContain('Object.prototype.toString.call(arr).slice(8, -1)')
		expect(result).not.toContain('arr.constructor')
	})

	it('应该处理混合的转换场景', () => {
		const wxsContent = `
			function genRegExp(str, flags) {
				return getRegExp(str, flags);
			}
			
			function test() {
				var mpxDashReg = genRegExp('(.+)MpxDash$');
				var mpxDashReplaceReg = genRegExp('[$]', 'g');
				var directReg = getRegExp('[A-Z]', 'g');
				var arr = [];
				var type = arr.constructor;
				var date = getDate();
				
				return {
					mpxDashReg: mpxDashReg,
					mpxDashReplaceReg: mpxDashReplaceReg,
					directReg: directReg,
					type: type,
					date: date
				};
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证混合场景下的正确转换
		// 转换变量参数的 getRegExp 调用为 new RegExp
		expect(result).toContain('new RegExp(str, flags)')
		expect(result).not.toContain('getRegExp(str, flags)')
		// 转换字符串字面量参数的 getRegExp 调用
		expect(result).toContain('/[A-Z]/g')
		expect(result).not.toContain('getRegExp(\'[A-Z]\', \'g\')')
		// 转换 constructor 属性访问
		expect(result).toContain('Object.prototype.toString.call(arr).slice(8, -1)')
		expect(result).not.toContain('arr.constructor')
		// 转换 getDate 调用
		expect(result).toContain('new Date()')
		expect(result).not.toContain('getDate()')
	})

	it('应该处理特殊字符的正则表达式', () => {
		const wxsContent = `
			function test() {
				var reg1 = getRegExp('\\\\d+');
				var reg2 = getRegExp('\\\\s*');
				var reg3 = getRegExp('\\\\w+', 'gi');
				return reg1;
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证转义字符被正确处理
		expect(result).toContain('/\\\\d+/')
		expect(result).toContain('/\\\\s*/')
		expect(result).toContain('/\\\\w+/gi')
	})

	it('应该正确处理实际 stringify wxs 文件的场景', () => {
		const wxsContent = `
			function genRegExp (str, flags) {
				if (false) {} else {
					return getRegExp(str, flags)
				}
			}

			var mpxDashReg = genRegExp('(.+)MpxDash$')
			var mpxDashReplaceReg = genRegExp('[$]', 'g')

			function hump2dash (value) {
				var reg = genRegExp('[A-Z]', 'g')
				return value.replace(reg, function (match) {
					return '-' + match.toLowerCase()
				})
			}

			function dash2hump (value) {
				var reg = genRegExp('-([a-z])', 'g')
				return value.replace(reg, function (match, p1) {
					return p1.toUpperCase()
				})
			}

			function parseStyleText (cssText) {
				var res = {}
				var listDelimiter = genRegExp(';(?![^(]*[)])', 'g')
				var propertyDelimiter = genRegExp(':(.+)')
				return res
			}
		`
		
		const result = processWxsContent(wxsContent, null, [], '', '')
		
		// 验证 genRegExp 函数内部的 getRegExp 调用被转换为 new RegExp
		expect(result).toContain('new RegExp(str, flags)')
		expect(result).not.toContain('getRegExp(str, flags)')
		
		// 验证所有的 genRegExp 调用都被保留（因为它们调用的是函数，不是直接的 getRegExp）
		expect(result).toContain('genRegExp(\'(.+)MpxDash$\')')
		expect(result).toContain('genRegExp(\'[$]\', \'g\')')
		expect(result).toContain('genRegExp(\'[A-Z]\', \'g\')')
		expect(result).toContain('genRegExp(\'-([a-z])\', \'g\')')
		expect(result).toContain('genRegExp(\';(?![^(]*[)])\', \'g\')')
		expect(result).toContain('genRegExp(\':(.+)\')')
		
		// 验证没有出现空的正则表达式（这是原始问题）
		expect(result).not.toContain('//;')
		expect(result).not.toContain('new RegExp()')
		
		// 验证 genRegExp 函数定义完整存在
		expect(result).toContain('function genRegExp(str, flags)')
	})
})

describe('generateSlotDirective - 动态slot指令生成', () => {
	it('静态 slot 值 - 应该使用命名插槽语法', () => {
		expect(generateSlotDirective('header')).toEqual('#header')
		expect(generateSlotDirective('footer')).toEqual('#footer')
		expect(generateSlotDirective('content')).toEqual('#content')
	})

	it('简单动态 slot 值 - 应该使用动态插槽语法', () => {
		expect(generateSlotDirective('{{slotName}}')).toEqual('#[slotName]')
		expect(generateSlotDirective('{{i.p0}}')).toEqual('#[i.p0]')
		expect(generateSlotDirective('{{item.name}}')).toEqual('#[item.name]')
	})

	it('索引属性的动态 slot 值 - 应该正确处理 i.p0 类型', () => {
		expect(generateSlotDirective('{{i.p0}}')).toEqual('#[i.p0]')
		expect(generateSlotDirective('{{i.p1}}')).toEqual('#[i.p1]')
		expect(generateSlotDirective('{{i.name}}')).toEqual('#[i.name]')
		expect(generateSlotDirective('{{j.p0}}')).toEqual('#[j.p0]')
		expect(generateSlotDirective('{{index.slot}}')).toEqual('#[index.slot]')
	})

	it('复杂动态 slot 值 - 应该正确解析表达式', () => {
		expect(generateSlotDirective('{{item.name + "_" + index}}')).toEqual('#[item.name + "_" + index]')
		expect(generateSlotDirective('{{prefix + slotType}}')).toEqual('#[prefix + slotType]')
		expect(generateSlotDirective('{{condition ? "slot1" : "slot2"}}')).toEqual('#[(condition ? "slot1" : "slot2")]')
	})

	it('包含数组索引的动态 slot 值 - 应该正确处理', () => {
		expect(generateSlotDirective('{{slots[index]}}')).toEqual('#[slots[index]]')
		expect(generateSlotDirective('{{list[i].name}}')).toEqual('#[list[i].name]')
	})

	it('混合文本和动态值的 slot - 应该正确处理字符串拼接', () => {
		expect(generateSlotDirective('slot_{{index}}')).toEqual('#[\'slot_\'+index]')
		expect(generateSlotDirective('{{prefix}}_suffix')).toEqual('#[prefix+\'_suffix\']')
		expect(generateSlotDirective('tab_{{type}}_{{index}}')).toEqual('#[\'tab_\'+type+\'_\'+index]')
	})

	it('空值处理 - 应该正确处理边界情况', () => {
		expect(generateSlotDirective('')).toEqual('#')
		expect(generateSlotDirective('{{}}')).toEqual('#[]')
	})

	it('特殊字符的 slot 名称 - 应该正确处理', () => {
		expect(generateSlotDirective('slot-header')).toEqual('#slot-header')
		expect(generateSlotDirective('slot_footer')).toEqual('#slot_footer')
		expect(generateSlotDirective('{{item["slot-name"]}}')).toEqual('#[item["slot-name"]]')
	})

	it('带空格的动态表达式 - 应该正确处理', () => {
		expect(generateSlotDirective('{{ item.name }}')).toEqual('#[item.name]')
		expect(generateSlotDirective('{{ prefix + "_" + suffix }}')).toEqual('#[prefix + "_" + suffix]')
	})

	it('嵌套对象属性访问 - 应该正确处理', () => {
		expect(generateSlotDirective('{{config.slots.header}}')).toEqual('#[config.slots.header]')
		expect(generateSlotDirective('{{data.list[index].slotName}}')).toEqual('#[data.list[index].slotName]')
	})
})
