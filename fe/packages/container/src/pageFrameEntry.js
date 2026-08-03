// 渲染层逻辑（vconsole、modDefine/modRequire 挂载、@dimina/render 初始化）都在
// container-sdk 里；Vite 多入口要求该 HTML 的脚本物理存在于本包，因此这里只转发。
import '@dimina/fe-container-sdk/pageFrame'
import '@dimina/fe-container-sdk/pageFrame.css'
