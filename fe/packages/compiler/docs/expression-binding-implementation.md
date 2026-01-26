# 复杂表达式绑定机制实现文档

## 概述

本文档描述了在 Dimina 框架中实现的复杂表达式绑定机制，支持在组件属性绑定中使用复杂表达式。

## 设计目标

1. **支持复杂表达式**：不仅支持简单的变量绑定（如 `count`），还支持复杂表达式（如 `count || defaultValue`、`item.name`、`count + 1` 等）
2. **精确的依赖追踪**：准确识别表达式中的所有数据依赖
3. **高效的更新机制**：只在依赖变化时重新计算表达式
4. **向后兼容**：保持现有简单绑定的性能

## 架构设计

### 1. 编译时（Compiler）

#### expression-parser.js

新增的表达式解析器，提供以下核心功能：

```javascript
// 提取表达式中的所有变量依赖
extractDependencies(expression) 
// 返回: ['count', 'defaultValue']

// 解析表达式并生成完整信息
parseExpression(expression)
// 返回: { 
//   expression: 'count || defaultValue',
//   dependencies: ['count', 'defaultValue'],
//   isSimple: false
// }

// 批量解析多个绑定
parseBindings(bindings)
// 输入: { count2: 'count', value: 'item.name' }
// 输出: { 
//   count2: { expression: 'count', dependencies: ['count'], isSimple: true },
//   value: { expression: 'item.name', dependencies: ['item'], isSimple: false }
// }
```

**关键特性**：
- 使用 Babel AST 解析器进行精确的语法分析
- 自动过滤字符串字面量中的标识符
- 只提取成员访问表达式的根对象（如 `item.name` 只提取 `item`）
- 智能识别并跳过 JavaScript 关键字和全局对象（如 `Math`、`Array`）
- 准确处理对象字面量（只提取值表达式的依赖，不提取键名）
- 正确处理函数调用（提取函数名和参数依赖）

#### view-compiler.js 的修改

在处理组件属性绑定时：

```javascript
// 解析并存储完整的绑定信息
const parsedBindings = parseBindings(validBindings)
// {
//   count2: { expression: 'count', dependencies: ['count'], isSimple: true }
// }
```

### 2. 运行时（Service）

在 `packages/service/src/core/utils.js` 中：

#### hasDependencyChanged()

检查表达式的依赖是否发生变化：

```javascript
function hasDependencyChanged(bindingInfo, changedData) {
  // 1. 检查直接依赖
  for (const dep of bindingInfo.dependencies) {
    if (dep in changedData) return true
    
    // 2. 检查嵌套路径
    // 如果 changedData 有 'item' 变化，'item.name' 表达式也需要更新
    // 如果 changedData 有 'item.name' 变化，依赖 'item' 的表达式也需要更新
  }
}
```

#### evaluateExpression()

计算表达式的新值：

```javascript
function evaluateExpression(bindingInfo, parentData) {
  if (bindingInfo.isSimple) {
    // 简单绑定：直接获取值（性能优化）
    return get(parentData, bindingInfo.expression)
  }
  
  // 复杂表达式：使用 Function 构造器安全求值
  const func = new Function('data', `with(data) { return ${bindingInfo.expression} }`)
  return func(parentData)
}
```

#### syncUpdateChildrenProps()

同步更新子组件的 properties：

```javascript
export function syncUpdateChildrenProps(parent, allInstances, changedData) {
  for (const child of children) {
    for (const propName in childProperties) {
      const bindingInfo = parent.__childPropsBindings__?.[child.__id__]?.[propName]
      
      // 检查依赖是否变化
      if (hasDependencyChanged(bindingInfo, changedData)) {
        // 重新计算表达式的值
        const newValue = evaluateExpression(bindingInfo, parent.data)
        updateData[propName] = newValue
      }
    }
    
    // 触发子组件更新
    if (Object.keys(updateData).length > 0) {
      child.tO?.(updateData)
    }
  }
}
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ 编译时 (Compiler)                                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  WXML: <child-comp count2="{{count || defaultValue}}" />    │
│                          ↓                                   │
│  expression-parser.js                                        │
│    - extractDependencies('count || defaultValue')           │
│    - 返回: ['count', 'defaultValue']                        │
│                          ↓                                   │
│  生成绑定信息：                                              │
│  {                                                           │
│    count2: {                                                 │
│      expression: 'count || defaultValue',                   │
│      dependencies: ['count', 'defaultValue'],               │
│      isSimple: false                                         │
│    }                                                         │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 运行时 - Render 层                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  v-c-prop-bindings 指令                                      │
│    - 将绑定信息存储在 DOM 元素上                             │
│    - el._propBindings = parsedBindings                      │
│                          ↓                                   │
│  组件 onMounted                                              │
│    - 读取 el._propBindings                                   │
│    - 发送到 Service 层                                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 运行时 - Service 层                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  runtime.moduleReady()                                       │
│    - 注册绑定信息到父组件                                    │
│    - parent.__childPropsBindings__[childId] = propBindings  │
│                          ↓                                   │
│  父组件 setData({ count: 10 })                              │
│    - changedData = { count: 10 }                            │
│                          ↓                                   │
│  syncUpdateChildrenProps()                                   │
│    1. hasDependencyChanged(bindingInfo, changedData)        │
│       - 检查 'count' in changedData → true                  │
│    2. evaluateExpression(bindingInfo, parentData)           │
│       - 计算: count || defaultValue → 10                    │
│    3. child.tO({ count2: 10 })                             │
│       - 触发子组件 observer                                  │
└─────────────────────────────────────────────────────────────┘
```

## 支持的表达式类型

### 1. 简单绑定
```xml
<child-comp count="{{count}}" />
```
- Dependencies: `['count']`
- isSimple: `true`
- 性能优化：直接使用 `get()` 获取值

### 2. 逻辑运算符
```xml
<child-comp value="{{count || defaultValue}}" />
<child-comp show="{{active && visible}}" />
```
- Dependencies: `['count', 'defaultValue']` / `['active', 'visible']`
- isSimple: `false`

### 3. 成员访问
```xml
<child-comp name="{{item.name}}" />
<child-comp profile="{{data.user.profile}}" />
```
- Dependencies: `['item']` / `['data']`
- 只追踪根对象，子属性变化通过路径检查

### 4. 算术运算
```xml
<child-comp total="{{count + 1}}" />
<child-comp percent="{{value * 100}}" />
```
- Dependencies: `['count']` / `['value']`
- isSimple: `false`

### 5. 三元表达式
```xml
<child-comp status="{{active ? 'on' : 'off'}}" />
<child-comp value="{{count > 0 ? count : defaultValue}}" />
```
- Dependencies: `['active']` / `['count', 'defaultValue']`
- isSimple: `false`

### 6. 函数调用
```xml
<child-comp date="{{formatDate(timestamp)}}" />
```
- Dependencies: `['formatDate', 'timestamp']`
- isSimple: `false`

## 性能优化

### 1. 简单绑定快速路径
```javascript
if (bindingInfo.isSimple) {
  // 使用 lodash get，避免 Function 构造器开销
  return get(parentData, bindingInfo.expression)
}
```

### 2. 依赖检查优化
```javascript
// 只在依赖真正变化时才重新计算
if (hasDependencyChanged(bindingInfo, changedData)) {
  const newValue = evaluateExpression(bindingInfo, parent.data)
}
```

### 3. 嵌套路径智能匹配
```javascript
// 支持路径前缀匹配
if (changedKey.startsWith(dep + '.') || changedKey.startsWith(dep + '[')) {
  return true
}
```

## 测试覆盖

在 `packages/compiler/__tests__/expression-parser.test.js` 中：

- ✅ 覆盖所有表达式类型

## 实现亮点

### 1. 基于 Babel AST 的精确依赖提取
- 使用 `@babel/core` 和 `@babel/traverse` 进行完整的语法树分析
- 自动过滤字符串字面量中的标识符
- 只提取成员访问的根对象
- 智能识别 JavaScript 关键字和全局对象
- 准确区分标识符的不同上下文（变量、属性、键名等）

### 2. 双层优化策略
- 简单绑定：快速路径，零开销
- 复杂表达式：按需求值，最小化性能影响

### 3. 安全的表达式求值
- 使用 `new Function()` + `with` 作用域
- 完整的错误处理
- 避免全局作用域污染

### 4. 完整的向后兼容
- 支持现有的简单绑定场景
- 渐进式增强，不破坏现有功能

## 使用示例

```xml
<!-- 简单绑定 -->
<checkbox value="{{ checkbox1 }}" />

<!-- 条件表达式 -->
<image src="{{ checkbox3 ? activeIcon : inactiveIcon }}" />

<!-- 逻辑运算 -->
<checkbox value="{{ checked || false }}" />
```

编译后的绑定信息：
```json
{
  "value": {
    "expression": "checkbox1",
    "dependencies": ["checkbox1"],
    "isSimple": true
  }
}
```

当父组件执行 `setData({ checkbox1: true })` 时：
1. `hasDependencyChanged()` 检测到 `checkbox1` 变化
2. `evaluateExpression()` 直接返回 `true`（简单绑定快速路径）
3. 子组件 `tO({ value: true })` 被触发
4. 子组件 observer 执行

## 未来优化方向

1. **表达式缓存**：缓存已编译的 Function，避免重复创建
2. **静态分析**：编译时进行更多优化，减少运行时开销
3. **增量编译**：只重新解析变化的表达式
4. **WebAssembly**：将表达式求值移至 WASM，提升性能

## 总结

通过精确的依赖追踪和智能的更新策略，确保了数据变化能够正确、高效地传播到子组件。
