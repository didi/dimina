const userFileName = 'dimina-file-system-demo.txt'
const defaultUserDataPath = 'difile://usr'

function getUserDataPath() {
  return wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : defaultUserDataPath
}

function getUserFilePath() {
  const userDataPath = getUserDataPath()
  return `${userDataPath}/${userFileName}`
}

function formatError(error) {
  if (!error) {
    return ''
  }
  if (typeof error === 'string') {
    return error
  }
  return error.errMsg || error.message || JSON.stringify(error)
}

function formatFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return ['目录为空']
  }
  return files
}

Page({
  data: {
    userDataPath: '',
    userFilePath: '',
    userContent: 'hello, dimina file system',
    readContent: '',
    readContentText: '未读取文件内容',
    userFiles: ['未读取'],
    tempFilePath: '',
    tempFilePathText: '暂无临时文件',
    hasTempFile: false,
    savedFilePath: '',
    savedFilePathText: '暂无缓存文件',
    savedFiles: ['暂无缓存文件'],
    resultTitle: '等待操作',
    resultDetail: '请点击下方按钮运行文件系统示例。',
    resultType: 'info'
  },

  onLoad() {
    console.log('wx.env', wx.env)
    this.setData({
      userDataPath: getUserDataPath(),
      userFilePath: getUserFilePath()
    })
    this.refreshUserFiles(false)
    this.refreshSavedFiles(false)
  },

  getFs() {
    if (typeof wx.getFileSystemManager !== 'function') {
      throw new Error('wx.getFileSystemManager is not supported')
    }
    return wx.getFileSystemManager()
  },

  showResult(title, detail, type = 'info') {
    this.setData({
      resultTitle: title,
      resultDetail: detail,
      resultType: type
    })
  },

  onContentInput(event) {
    this.setData({
      userContent: event.detail.value
    })
  },

  writeUserFile() {
    try {
      const filePath = getUserFilePath()
      this.getFs().writeFileSync(filePath, this.data.userContent, 'utf8')
      this.setData({
        userFilePath: filePath
      })
      this.refreshUserFiles(false)
      this.showResult('本地用户文件写入成功', filePath, 'success')
    }
    catch (error) {
      this.showResult('本地用户文件写入失败', formatError(error), 'error')
    }
  },

  readUserFile() {
    try {
      const filePath = getUserFilePath()
      const content = this.getFs().readFileSync(filePath, 'utf8')
      this.setData({
        readContent: content,
        readContentText: content || '文件内容为空',
        userFilePath: filePath
      })
      this.showResult('本地用户文件读取成功', content, 'success')
    }
    catch (error) {
      this.showResult('本地用户文件读取失败', formatError(error), 'error')
    }
  },

  refreshUserFiles(showMessage = true) {
    try {
      const userDataPath = getUserDataPath()
      const files = this.getFs().readdirSync(userDataPath)
      this.setData({
        userDataPath,
        userFilePath: getUserFilePath(),
        userFiles: formatFiles(files)
      })
      if (showMessage) {
        this.showResult('本地用户目录读取成功', userDataPath, 'success')
      }
    }
    catch (error) {
      this.setData({
        userFiles: ['读取失败']
      })
      if (showMessage) {
        this.showResult('本地用户目录读取失败', formatError(error), 'error')
      }
    }
  },

  removeUserFile() {
    try {
      const filePath = getUserFilePath()
      this.getFs().unlinkSync(filePath)
      this.setData({
        readContent: '',
        readContentText: '未读取文件内容'
      })
      this.refreshUserFiles(false)
      this.showResult('本地用户文件删除成功', filePath, 'success')
    }
    catch (error) {
      this.showResult('本地用户文件删除失败', formatError(error), 'error')
    }
  },

  chooseTempFile() {
    wx.chooseImage({
      count: 1,
      success: res => {
        const tempFilePath = res.tempFilePaths[0]
        this.setData({
          tempFilePath,
          tempFilePathText: tempFilePath,
          hasTempFile: true
        })
        this.showResult('临时文件已生成', tempFilePath, 'success')
      },
      fail: error => {
        this.showResult('选择图片失败', formatError(error), 'error')
      }
    })
  },

  saveTempFile() {
    if (!this.data.tempFilePath) {
      this.showResult('请先选择图片', 'chooseImage 会返回一个本地临时文件路径。', 'info')
      return
    }

    try {
      this.getFs().saveFile({
        tempFilePath: this.data.tempFilePath,
        success: res => {
          this.setData({
            savedFilePath: res.savedFilePath,
            savedFilePathText: res.savedFilePath
          })
          this.refreshSavedFiles(false)
          this.showResult('临时文件已保存为缓存文件', res.savedFilePath, 'success')
        },
        fail: error => {
          this.showResult('保存缓存文件失败', formatError(error), 'error')
        }
      })
    }
    catch (error) {
      this.showResult('保存缓存文件失败', formatError(error), 'error')
    }
  },

  refreshSavedFiles(showMessage = true) {
    try {
      this.getFs().getSavedFileList({
        success: res => {
          const fileList = res.fileList || []
          this.setData({
            savedFiles: fileList.length > 0
              ? fileList.map(item => `${item.filePath} (${item.size}B)`)
              : ['暂无缓存文件']
          })
          if (showMessage) {
            this.showResult('缓存文件列表读取成功', `共 ${fileList.length} 个文件`, 'success')
          }
        },
        fail: error => {
          if (showMessage) {
            this.showResult('缓存文件列表读取失败', formatError(error), 'error')
          }
        }
      })
    }
    catch (error) {
      if (showMessage) {
        this.showResult('缓存文件列表读取失败', formatError(error), 'error')
      }
    }
  },

  removeSavedFile() {
    if (!this.data.savedFilePath) {
      this.showResult('没有可删除的缓存文件', '请先保存一个临时文件。', 'info')
      return
    }

    try {
      this.getFs().removeSavedFile({
        filePath: this.data.savedFilePath,
        success: () => {
          const filePath = this.data.savedFilePath
          this.setData({
            savedFilePath: '',
            savedFilePathText: '暂无缓存文件'
          })
          this.refreshSavedFiles(false)
          this.showResult('缓存文件删除成功', filePath, 'success')
        },
        fail: error => {
          this.showResult('缓存文件删除失败', formatError(error), 'error')
        }
      })
    }
    catch (error) {
      this.showResult('缓存文件删除失败', formatError(error), 'error')
    }
  }
})
