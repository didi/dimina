# 组件间关系 (Relations) 功能实现

## 概述

本实现完全支持微信小程序的组件间关系功能，允许组件之间建立 parent-child、ancestor-descendant 等关系，并提供相应的生命周期函数和 API。

## 功能特性

### 1. 支持的关系类型

- **parent**: 父子关系中的父组件
- **child**: 父子关系中的子组件  
- **ancestor**: 祖先-后代关系中的祖先组件
- **descendant**: 祖先-后代关系中的后代组件

### 2. 关系生命周期

- **linked**: 关系建立时调用
- **linkChanged**: 关系发生变化时调用（如组件移动）
- **unlinked**: 关系断开时调用

### 3. 路径解析

- 支持相对路径：`./component`、`../sibling/component`
- 支持绝对路径：`/path/to/component`
- 自动解析路径映射关系

### 4. Behavior 支持

- 支持通过 `target` 属性指定目标 behavior
- 自动合并 behavior 中的 relations 配置

## API 参考

### getRelationNodes(relationPath)

获取指定关系路径对应的所有关联节点。

```javascript
// 获取所有子组件
const children = this.getRelationNodes('./child-component')

// 获取父组件
const parents = this.getRelationNodes('./parent-component')
```

**参数：**
- `relationPath` (string): 关系路径，必须与 relations 配置中的路径一致

**返回值：**
- Array: 关联组件实例数组

## 使用示例

### 基本父子关系

```javascript
// 父组件
Component({
  relations: {
    './child-component': {
      type: 'child',
      linked: function(target) {
        console.log('子组件已连接:', target)
        // 可以直接调用子组件方法
        target.updateFromParent(this.data.someValue)
      },
      unlinked: function(target) {
        console.log('子组件已断开:', target)
      }
    }
  },
  
  methods: {
    updateAllChildren: function() {
      const children = this.getRelationNodes('./child-component')
      children.forEach(child => {
        child.updateFromParent(this.data.someValue)
      })
    }
  }
})

// 子组件
Component({
  relations: {
    './parent-component': {
      type: 'parent',
      linked: function(target) {
        this.parent = target
      }
    }
  },
  
  methods: {
    updateFromParent: function(value) {
      this.setData({ parentValue: value })
    },
    
    notifyParent: function(data) {
      if (this.parent) {
        this.parent.handleChildEvent(data)
      }
    }
  }
})
```

### 祖先-后代关系

```javascript
// 祖先组件
Component({
  relations: {
    './descendant-component': {
      type: 'descendant',
      linked: function(target) {
        this.descendants = this.descendants || []
        this.descendants.push(target)
      }
    }
  },
  
  methods: {
    broadcastMessage: function(message) {
      const descendants = this.getRelationNodes('./descendant-component')
      descendants.forEach(descendant => {
        descendant.receiveMessage(message)
      })
    }
  }
})

// 后代组件
Component({
  relations: {
    './ancestor-component': {
      type: 'ancestor',
      linked: function(target) {
        this.ancestor = target
      }
    }
  },
  
  methods: {
    receiveMessage: function(message) {
      console.log('收到祖先消息:', message)
    }
  }
})
```

### 使用 Behavior

```javascript
const parentBehavior = Behavior({
  relations: {
    './child-component': {
      type: 'child',
      target: 'childBehavior',
      linked: function(target) {
        console.log('具有 childBehavior 的组件已连接')
      }
    }
  }
})

Component({
  behaviors: [parentBehavior],
  // 其他配置...
})
```

## 实现细节

### 1. 关系初始化

- 在组件构造时调用 `#initRelations()` 初始化关系配置
- 解析关系路径并存储映射关系
- 为每个关系路径初始化节点数组

### 2. 关系建立

- 在组件 `attached` 生命周期后立即建立关系
- 遍历所有实例查找匹配的组件
- 根据关系类型和路径匹配建立连接
- 调用 `linked` 生命周期函数
- **双向关系建立**: 当组件 attached 时，会通知其他组件重新检查关系，确保双向关系正确建立

### 3. 关系维护

- 组件移动时触发 `linkChanged` 函数
- 组件销毁时自动断开所有关系
- 调用 `unlinked` 生命周期函数

### 4. 路径解析算法

```javascript
#resolveRelationPath(relationPath) {
  if (relationPath.startsWith('./')) {
    // 相对路径处理
    const currentDir = this.is.substring(0, this.is.lastIndexOf('/'))
    return `${currentDir}/${relationPath.substring(2)}`
  } else if (relationPath.startsWith('../')) {
    // 上级路径处理
    // 解析 .. 路径段
  } else {
    // 绝对路径
    return relationPath
  }
}
```

## 测试覆盖

实现包含完整的测试套件，覆盖以下场景：

- ✅ 父子关系建立和断开
- ✅ 祖先-后代关系建立
- ✅ 关系生命周期函数调用
- ✅ 组件销毁时关系清理
- ✅ 相对路径解析
- ✅ getRelationNodes API
- ✅ **双向关系建立** - 父组件先创建时也能正确获取后创建的子组件

## 注意事项

1. **双向关系**: 关系建立是双向的，组件创建顺序不影响关系的正确建立
2. **性能考虑**: 关系建立在组件 attached 时立即执行，确保及时性
3. **内存管理**: 组件销毁时自动清理所有关系，避免内存泄漏
4. **错误处理**: 关系生命周期函数执行错误不会影响组件正常运行
5. **路径匹配**: 支持多种路径格式，自动解析相对路径

## 兼容性

完全兼容微信小程序官方组件间关系 API，可以无缝迁移现有代码。

## 参考文档

- [微信小程序组件间关系官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/relations.html) 