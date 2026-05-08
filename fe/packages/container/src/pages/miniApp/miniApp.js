import { LAUNCH_SCREEN_MIN_MS, WAIT_TRANSITION_TIMEOUT_MS } from '@/constants/animation'
import { AppManager } from '@/core/appManager'
import { Bridge } from '@/core/bridge'
import { JSCore } from '@/core/jscore'
import { HashRouter } from '@/utils/hashRouter'
import { mergePageConfig, queryPath, readFile, sleep, uuid } from '@/utils/util'

// 等待元素上指定 transition property 结束，带超时兜底防止动画未触发时永久阻塞
const waitTransitionEnd = (el, property, timeout = WAIT_TRANSITION_TIMEOUT_MS) =>
	new Promise(resolve => {
		const timer = setTimeout(resolve, timeout)
		const handler = (e) => {
			if (!property || e.propertyName === property) {
				clearTimeout(timer)
				el.removeEventListener('transitionend', handler)
				resolve()
			}
		}
		el.addEventListener('transitionend', handler)
	})
import tpl from './miniApp.html?raw'
import './miniApp.scss'

export class MiniApp {
  constructor(opts) {
    this.appInfo = opts;
    this.id = `mini_app_${uuid()}`;
    this.parent = null;
    this.appId = opts.appId;
    this.appConfig = null;
    this.bridgeList = [];
    this.jscore = new JSCore(this);
    this.webviewsContainer = null;
    this.webviewAnimaEnd = true;
    this.el = document.createElement("div");
    this.el.classList.add("dimina-native-view");
    this.toastInfo = {
      dom: null,
      timer: null,
    };
    this.color = null;
    // TabBar 状态（参考鸿蒙 DMPTabBarContainerView 的"按需创建 + 持久缓存"模型）
    this.tabBarPagePaths = new Set(); // app.tabBar.list 中声明的所有 tab 路径
    this.tabBarBridges = new Map(); // pagePath -> bridge：懒加载的持久 tab 池
    this.currentTabPath = null; // 当前激活的 tab 路径；null 表示当前不在任何 tab 页
  }

  viewDidLoad() {
    this.initPageFrame();
    this.webviewsContainer = this.el.querySelector(
      ".dimina-mini-app__webviews",
    );
    this.showLaunchScreen();
    this.bindMoreEvent();
    this.bindCloseEvent();
    this.initApp();
  }

  async initApp() {
    // 1. 等待逻辑线程初始化
    await this.jscore.init();

    // 2. 模拟拉取小程序资源
    await sleep(260);

    // 3. 读取配置文件
    const root = "main";
    const configPath = `${this.appInfo.appId}/${root}/app-config.json`;
    const configContent = await readFile(
      `${import.meta.env.BASE_URL}${configPath}`,
    );

    if (!configContent) {
      return;
    }

    this.appConfig = JSON.parse(configContent);

    if (this.appConfig.app.tabBar && this.appConfig.app.tabBar.list) {
      this.tabBarPagePaths = new Set(
        this.appConfig.app.tabBar.list.map((item) => item.pagePath),
      );
    }

    const entryPagePath =
      this.appInfo.pagePath || this.appConfig.app.entryPagePath;

    // 4. 读取页面配置
    const pageConfig = this.appConfig.modules[entryPagePath];
    const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);

    // 5. 设置状态栏的颜色模式
    this.updateTargetPageColorStyle(mergeConfig);

    // 6. 创建通信 bridge
    const entryPageBridge = await this.createBridge({
      pagePath: entryPagePath,
      query: this.appInfo.query,
      scene: this.appInfo.scene,
      jscore: this.jscore,
      isRoot: true,
      root,
      appId: this.appInfo.appId,
      pages: this.appConfig.app.pages,
      configInfo: mergeConfig,
    });

    this.bridgeList.push(entryPageBridge);

    // 入口若是 tab 页：登记到 tab 池并设为当前 tab
    const entryIsTabPage = this.tabBarPagePaths.has(entryPagePath);
    if (entryIsTabPage) {
      this.tabBarBridges.set(entryPagePath, entryPageBridge);
      this.currentTabPath = entryPagePath;
    }

    entryPageBridge.start();
    HashRouter.sync(this.appId, entryPagePath, this.appInfo.query);

    // 7. 渲染 TabBar：仅在入口为 tab 页时显示
    if (this.appConfig.app.tabBar) {
      this._renderTabBar(this.appConfig.app.tabBar);
      this._setTabBarVisible(entryIsTabPage);
    }

    // 8.隐藏 loading
    this.hideLaunchScreen();
  }

  // 创建一个bridge对象
  async createBridge(opts) {
    const {
      jscore,
      configInfo,
      isRoot,
      appId,
      pagePath,
      query,
      scene,
      pages,
      root,
    } = opts;
    const bridge = new Bridge({
      jscore,
      configInfo,
      isRoot,
      appId,
      pagePath,
      query,
      scene,
      pages,
      root,
    });

    bridge.parent = this;
    await bridge.init();
    return bridge;
  }

  onPresentIn() {
    const currentBridge = this.bridgeList[this.bridgeList.length - 1];
    // 首次异步创建时， bridge 不存在，会在[Service]自行调用 invokeInitLifecycle
    currentBridge?.appShow();
    currentBridge?.pageShow();
    if (currentBridge) {
      HashRouter.sync(
        this.appId,
        currentBridge.opts.pagePath,
        currentBridge.opts.query,
      );
    }
  }

  onPresentOut() {
    const currentBridge = this.bridgeList[this.bridgeList.length - 1];

    currentBridge?.appHide();
    currentBridge?.pageHide();
  }

  initPageFrame() {
    this.el.innerHTML = tpl;
  }

  // 设置指定页面状态栏的颜色模式
  updateTargetPageColorStyle(mergeConfig) {
    const { navigationBarTextStyle } = mergeConfig;
    this.updateActionColorStyle(navigationBarTextStyle);
  }

  showLaunchScreen() {
    const launchScreen = this.el.querySelector(
      ".dimina-mini-app__launch-screen",
    );
    const name = this.el.querySelector(".dimina-mini-app__name");
    const logo = this.el.querySelector(".dimina-mini-app__logo-img-url");

    this.updateActionColorStyle("black");
    name.innerHTML = this.appInfo.name;
    logo.src = this.appInfo.logo;
    launchScreen.style.display = "block";
  }

  hideLaunchScreen() {
    const startPage = this.el.querySelector(".dimina-mini-app__launch-screen");
    startPage.style.display = "none";
  }

  updateActionColorStyle(color) {
    this.color = color;
    const action = this.el.querySelector(
      ".dimina-mini-app-navigation__actions",
    );

    if (color === "white") {
      action.classList.remove("dimina-mini-app-navigation__actions--black");
      action.classList.add("dimina-mini-app-navigation__actions--white");
    } else if (color === "black") {
      action.classList.remove("dimina-mini-app-navigation__actions--white");
      action.classList.add("dimina-mini-app-navigation__actions--black");
    }

    this.parent.updateStatusBarColor(color);
  }

  restoreColorStyle() {
    this.updateActionColorStyle(this.color);
  }

  createCallbackFunction(funcId) {
    if (funcId) {
      return (args) => {
        this.jscore.postMessage({
          type: "triggerCallback",
          body: {
            id: funcId,
            args,
          },
        });
      };
    }
  }

  async navigateTo(opts) {
    // 防抖处理
    if (!this.webviewAnimaEnd) {
      return;
    }
    this.webviewAnimaEnd = false;

    const { url, success } = opts;
    const { query, pagePath } = queryPath(url);
    const onSuccess = this.createCallbackFunction(success);

    const pageConfig = this.appConfig.modules[pagePath];
    const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);
    // 更新状态栏颜色模式
    this.updateTargetPageColorStyle(mergeConfig);

    // 创建新的入口页面的 bridge
    const bridge = await this.createBridge({
      pagePath,
      query,
      scene: this.appInfo.scene,
      jscore: this.jscore,
      isRoot: false,
      root: pageConfig?.root || "main",
      appId: this.appInfo.appId,
      pages: this.appConfig.app.pages,
      configInfo: mergeConfig,
    });

    // 获取前一个bridge
    const preBridge = this.bridgeList[this.bridgeList.length - 1];
    const preWebview = preBridge.webview;

    this.bridgeList.push(bridge);

    // 触发新页面的初始化逻辑
    bridge.start();
    HashRouter.sync(this.appId, pagePath, query);

    // 上一个页面推出
    preWebview.el.classList.remove("dimina-native-view--instage");
    preWebview.el.classList.add("dimina-native-view--slide-out");
    preWebview.el.classList.add("dimina-native-view--linear-anima");
    preBridge?.pageHide();

    // 新页面推入
    bridge.webview.el.style.zIndex = this.bridgeList.length + 1;
    bridge.webview.el.classList.add("dimina-native-view--enter-anima");
    bridge.webview.el.classList.add("dimina-native-view--instage");
    await sleep(540);

    // 页面进入后移出动画相关class
    this.webviewAnimaEnd = true;
    preWebview.el.classList.remove("dimina-native-view--linear-anima");
    bridge.webview.el.classList.remove("dimina-native-view--before-enter");
    bridge.webview.el.classList.remove("dimina-native-view--enter-anima");
    bridge.webview.el.classList.remove("dimina-native-view--instage");

    // navigateTo 总是进入非 tab 页（target 是 tab 页时按 wechat 规范应使用 switchTab），隐藏 TabBar
    this._setTabBarVisible(false);

    onSuccess?.();
  }

  reLaunch(opts) {
    // 防抖处理
    if (!this.webviewAnimaEnd) {
      return;
    }
    this.webviewAnimaEnd = false;

    const { url, success, fail, complete } = opts;
    const { query, pagePath } = queryPath(url);
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      const pageConfig = this.appConfig.modules[pagePath];
      const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);

      this.updateTargetPageColorStyle(mergeConfig);

      // 销毁所有 bridge：当前可见栈 + tab 池（用 Set 去重，避免同一 bridge 被销毁两次）
      const allBridges = new Set([
        ...this.bridgeList,
        ...this.tabBarBridges.values(),
      ]);
      for (const bridge of allBridges) {
        bridge.destroy();
        bridge.webview?.el?.remove();
      }
      this.bridgeList.length = 0;
      this.tabBarBridges.clear();
      this.currentTabPath = null;

      if (this.webviewsContainer) {
        this.webviewsContainer.innerHTML = "";
      }

      this.createBridge({
        pagePath,
        query,
        scene: this.appInfo.scene,
        jscore: this.jscore,
        isRoot: true,
        root: pageConfig?.root || "main",
        appId: this.appInfo.appId,
        pages: this.appConfig.app.pages,
        configInfo: mergeConfig,
      })
        .then((bridge) => {
          this.bridgeList.push(bridge);
          bridge.webview.el.style.zIndex = 1;

          // 入口若是 tab 页：登记到池并显示 TabBar
          if (this.tabBarPagePaths.has(pagePath)) {
            this.tabBarBridges.set(pagePath, bridge);
            this.currentTabPath = pagePath;
            this._setTabBarVisible(true);
            this._updateTabBarSelection(pagePath);
          } else {
            this._setTabBarVisible(false);
          }

          bridge.start();
          HashRouter.sync(this.appId, pagePath, query);

          this.webviewAnimaEnd = true;
          onSuccess?.({ errMsg: "reLaunch:ok" });
          onComplete?.();
        })
        .catch((error) => {
          onFail?.({ errMsg: `reLaunch:fail ${error.message}` });
          onComplete?.();
          this.webviewAnimaEnd = true;
        });
    } catch (error) {
      onFail?.({ errMsg: `reLaunch:fail ${error.message}` });
      onComplete?.();
      this.webviewAnimaEnd = true;
    }
  }

  redirectTo(opts) {
    // 防抖处理
    if (!this.webviewAnimaEnd) {
      return;
    }
    this.webviewAnimaEnd = false;

    const { url, success } = opts;
    const { query, pagePath } = queryPath(url);
    const onSuccess = this.createCallbackFunction(success);

    // 获取当前 bridge
    const curBridge = this.bridgeList[this.bridgeList.length - 1];
    const pageConfig = this.appConfig.modules[pagePath];
    const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);

    this.updateTargetPageColorStyle(mergeConfig);
    // 更新 bridge
    curBridge.destroy();
    curBridge.opts = {
      ...curBridge.opts,
      pagePath,
      query,
      configInfo: mergeConfig,
    };
    curBridge.resetStatus();
    curBridge.start();
    HashRouter.sync(this.appId, pagePath, query);

    this.webviewAnimaEnd = true;
    onSuccess?.();
  }

  async navigateBack() {
    if (this.bridgeList.length < 2) {
      return;
    }

    if (!this.webviewAnimaEnd) {
      return;
    }

    this.webviewAnimaEnd = false;

    const currentBridge = this.bridgeList.pop();
    const preBridge = this.bridgeList[this.bridgeList.length - 1];

    const pageConfig = this.appConfig.modules[preBridge.opts.pagePath];
    const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);

    // 更新状态栏颜色模式
    this.updateTargetPageColorStyle(mergeConfig);

    // 当前页面推出
    currentBridge.webview.el.classList.add("dimina-native-view--before-enter");
    currentBridge.webview.el.classList.add("dimina-native-view--enter-anima");

    // 触发当前页面的生命周期函数
    currentBridge?.destroy();

    // 上一个页面推入
    preBridge.webview.el.classList.remove("dimina-native-view--slide-out");
    preBridge.webview.el.classList.add("dimina-native-view--instage");
    preBridge.webview.el.classList.add("dimina-native-view--enter-anima");

    // 触发上一个页面的生命周期函数
    preBridge?.pageShow();
    HashRouter.sync(this.appId, preBridge.opts.pagePath, preBridge.opts.query);
    await sleep(540);
    this.webviewAnimaEnd = true;

    // 页面进入后移出动画相关class
    preBridge.webview.el.classList.remove("dimina-native-view--enter-anima");
    preBridge.webview.el.classList.remove("dimina-native-view--instage");
    currentBridge.webview.el.parentNode.removeChild(currentBridge.webview.el);
  }

  /**
   * Switch to a tabBar page (multi-iframe approach for WebView reuse)
   * Similar to HarmonyOS/iOS/Android container implementations
   */
  async switchTab(opts) {
    console.log("🔄 [switchTab] 开始切换", opts);

    try {
      const { url, success, fail, complete } = opts;
      console.log("  Step 1: 解析参数", { url, success, fail, complete });

      let { query, pagePath } = queryPath(url);
      console.log("  Step 2: 解析路径（原始）", { query, pagePath });

      // Remove leading slash from pagePath to match tabBarPagePaths format
      if (pagePath.startsWith("/")) {
        pagePath = pagePath.substring(1);
      }
      console.log("  Step 2b: 去除前导斜杠后", { pagePath });

      const onSuccess = this.createCallbackFunction(success);
      const onFail = this.createCallbackFunction(fail);
      const onComplete = this.createCallbackFunction(complete);
      console.log("  Step 3: 创建回调函数");

      // Check if this is a tabBar page
      console.log("  Step 4: 检查是否为 tabBar 页面");
      console.log("  tabBarPagePaths:", Array.from(this.tabBarPagePaths));
      console.log("  pagePath:", pagePath);
      console.log("  has(pagePath):", this.tabBarPagePaths.has(pagePath));

      if (!this.tabBarPagePaths.has(pagePath)) {
        console.warn("❌ [switchTab] 目标页面不是 tabBar 页面:", pagePath);
        onFail?.({ errMsg: "switchTab:fail not a tabBar page" });
        onComplete?.();
        return;
      }

      console.log("✅ Step 5: 确认是 tabBar 页面，继续执行");

      // Log current state
      console.log("📊 [switchTab] 当前状态快照:");
      console.log("  bridgeList 长度:", this.bridgeList.length);
      console.log(
        "  bridgeList 页面路径:",
        this.bridgeList.map((b) => ({
          id: b.id,
          pagePath: b.opts.pagePath,
          isTabBar: this.tabBarPagePaths.has(b.opts.pagePath),
        })),
      );
      console.log("  tabBarBridges 数量:", this.tabBarBridges.size);

      // Hide current page
      console.log("  Step 6: 隐藏当前页面");
      const currentBridge = this.bridgeList[this.bridgeList.length - 1];
      console.log(
        "  currentBridge:",
        currentBridge?.opts?.pagePath,
        "id:",
        currentBridge?.id,
      );
      if (currentBridge) {
        console.log("  👁️ 隐藏当前页面:", currentBridge.opts.pagePath);
        currentBridge.pageHide();
        currentBridge.webview.el.style.display = "none";
      } else {
        console.log("  ⚠️ 没有当前页面需要隐藏");
      }

      // Remove all non-tabBar pages from stack
      const nonTabBarBridges = this.bridgeList.filter(
        (bridge) => !this.tabBarPagePaths.has(bridge.opts.pagePath),
      );
      if (nonTabBarBridges.length > 0) {
        console.log(`  🗑️ 移除 ${nonTabBarBridges.length} 个非 tabBar 页面:`);
        nonTabBarBridges.forEach((bridge) => {
          console.log("    - 移除:", bridge.opts.pagePath, "id:", bridge.id);
          bridge.destroy();
          if (bridge.webview?.el) {
            bridge.webview.el.remove();
          }
          const index = this.bridgeList.indexOf(bridge);
          if (index >= 0) {
            this.bridgeList.splice(index, 1);
          }
        });
        console.log("  清理后 bridgeList 长度:", this.bridgeList.length);
        console.log(
          "  清理后 bridgeList:",
          this.bridgeList.map((b) => b.opts.pagePath),
        );
      }

      // Check if target tabBar page exists
      console.log("  Step 7: 查找目标 tabBar 页面");
      console.log(
        "  tabBarBridges keys:",
        Array.from(this.tabBarBridges.keys()),
      );
      let targetBridge = this.tabBarBridges.get(pagePath);
      console.log("  targetBridge:", targetBridge);

      if (targetBridge) {
        // Reuse existing tabBar page
        console.log("  ✅ 复用已存在的 tabBar 页面:", pagePath);
        console.log("    targetBridge id:", targetBridge.id);
        console.log("    targetBridge webview:", targetBridge.webview?.el);

        // Show target page
        targetBridge.webview.el.style.display = "block";

        // Remove animation classes to prevent white screen
        targetBridge.webview.el.classList.remove(
          "dimina-native-view--slide-out",
        );
        targetBridge.webview.el.classList.remove(
          "dimina-native-view--enter-anima",
        );
        targetBridge.webview.el.classList.remove("dimina-native-view--instage");
        console.log("    已设置 display = block 并清除动画类");

        // Move to stack top if not already there
        const index = this.bridgeList.indexOf(targetBridge);
        console.log(
          "    当前在栈中的位置:",
          index,
          "栈总长度:",
          this.bridgeList.length,
        );
        if (index >= 0 && index !== this.bridgeList.length - 1) {
          this.bridgeList.splice(index, 1);
          this.bridgeList.push(targetBridge);
          console.log("    ✅ 更新栈顺序，移到栈顶");
          console.log(
            "    新栈顺序:",
            this.bridgeList.map((b) => b.opts.pagePath),
          );
        } else if (index < 0) {
          console.error("    ⚠️ 警告：targetBridge 不在 bridgeList 中！");
        }

        // Trigger lifecycle
        targetBridge.pageShow();
        HashRouter.sync(this.appId, pagePath, query);

        // Update TabBar selection
        this.updateTabBarSelection(pagePath);

        onSuccess?.({ errMsg: "switchTab:ok" });
      } else {
        // Create new tabBar page
        console.log("  🆕 创建新的 tabBar 页面:", pagePath);

        const pageConfig = this.appConfig.modules[pagePath];
        const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig);

        // Update status bar color
        this.updateTargetPageColorStyle(mergeConfig);

        // Create bridge
        const bridge = await this.createBridge({
          pagePath,
          query,
          scene: this.appInfo.scene,
          jscore: this.jscore,
          isRoot: true,
          root: pageConfig?.root || "main",
          appId: this.appInfo.appId,
          pages: this.appConfig.app.pages,
          configInfo: mergeConfig,
        });

        // Store in tabBar bridges map
        this.tabBarBridges.set(pagePath, bridge);

        // Add to bridge list
        this.bridgeList.push(bridge);

        // Show the page
        bridge.webview.el.style.display = "block";
        bridge.webview.el.style.zIndex = 1;

        // Remove animation classes to prevent white screen
        bridge.webview.el.classList.remove("dimina-native-view--slide-out");
        bridge.webview.el.classList.remove("dimina-native-view--enter-anima");
        bridge.webview.el.classList.remove("dimina-native-view--instage");

        // Start bridge
        bridge.start();
        HashRouter.sync(this.appId, pagePath, query);

        // Update TabBar selection
        this.updateTabBarSelection(pagePath);

        console.log("  ✅ TabBar 页面创建完成");

        onSuccess?.({ errMsg: "switchTab:ok" });
      }

      onComplete?.();

      // Final state snapshot
      console.log("📊 [switchTab] 切换完成后的最终状态:");
      console.log("  bridgeList 长度:", this.bridgeList.length);
      console.log(
        "  bridgeList 详情:",
        this.bridgeList.map((b) => ({
          pagePath: b.opts.pagePath,
          id: b.id,
          display: b.webview?.el?.style?.display,
        })),
      );
      console.log(
        "  tabBarBridges 缓存:",
        Array.from(this.tabBarBridges.entries()).map(([path, bridge]) => ({
          path,
          bridgeId: bridge.id,
        })),
      );
      console.log("✅✅✅ [switchTab] 切换完成");
    } catch (error) {
      console.error("❌❌❌ [switchTab] 捕获到错误:", error);
      console.error("错误堆栈:", error.stack);
      onFail?.({ errMsg: `switchTab:fail ${error.message}` });
      onComplete?.();
    }
  }

  /**
   * 规范化 pagePath：去掉前导 '/'，与 app.tabBar.list 中声明的格式对齐
   */
  _normalizePath(path) {
    if (!path) return "";
    return path.startsWith("/") ? path.substring(1) : path;
  }

  /**
   * 渲染 TabBar UI（一次性渲染，后续通过 _setTabBarVisible / _updateTabBarSelection 调整）
   */
  _renderTabBar(tabBarConfig) {
    const tabBarEl = this.el.querySelector(".dimina-mini-app__tabbar");
    if (!tabBarEl) return;

    const { color, backgroundColor, borderStyle, list } = tabBarConfig;
    const borderColor =
      borderStyle === "white" ? "#ffffff" : "rgba(0, 0, 0, 0.2)";
    const normalColor = color || "#999999";

    tabBarEl.innerHTML = `
			<div class="dimina-tabbar" style="background-color: ${backgroundColor || "#ffffff"}; border-top: 0.5px solid ${borderColor};">
				${list
          .map(
            (item, index) => `
					<div class="dimina-tabbar-item" data-path="${item.pagePath}" data-index="${index}">
						${
              item.iconPath
                ? `<img class="dimina-tabbar-icon dimina-tabbar-icon-default"
									src="${import.meta.env.BASE_URL}${this.appId}/main/${item.iconPath}" alt="${item.text}" />
								${
                  item.selectedIconPath
                    ? `<img class="dimina-tabbar-icon dimina-tabbar-icon-selected"
											src="${import.meta.env.BASE_URL}${this.appId}/main/${item.selectedIconPath}" alt="${item.text}" />`
                    : ""
                }`
                : ""
            }
						<span class="dimina-tabbar-text" style="color: ${normalColor};">${item.text}</span>
					</div>
				`,
          )
          .join("")}
			</div>
		`;

    // 事件委托：单个监听器即可处理所有 tab 项点击
    tabBarEl.addEventListener("click", (e) => {
      const item = e.target.closest(".dimina-tabbar-item");
      if (!item) return;
      const path = item.getAttribute("data-path");
      if (path) {
        this.switchTab({ url: `/${path}` });
      }
    });

    this._updateTabBarSelection(this.currentTabPath);
  }

/**
	 * 控制 TabBar 容器及 webviews 容器的底部 padding
	 */
	_setTabBarVisible(visible) {
		const tabBarEl = this.el.querySelector('.dimina-mini-app__tabbar')
		if (!tabBarEl) return
		tabBarEl.style.display = visible ? 'block' : 'none'
		const webviewsContainer = this.el.querySelector('.dimina-mini-app__webviews')
		if (webviewsContainer) {
			webviewsContainer.style.bottom = visible ? '49px' : '0'
		}
	}

	/**
	 * 仅更新选中态（颜色 / 图标 / class），不重渲染 TabBar
	 */
	_updateTabBarSelection(currentPath) {
		const tabBarEl = this.el.querySelector('.dimina-mini-app__tabbar')
		if (!tabBarEl) return

		const tabBarConfig = this.appConfig?.app?.tabBar
		if (!tabBarConfig) return

		const normalColor = tabBarConfig.color || '#999999'
		const selectedColor = tabBarConfig.selectedColor || '#1890ff'

		tabBarEl.querySelectorAll('.dimina-tabbar-item').forEach((item) => {
			const path = item.getAttribute('data-path')
			const isSelected = path === currentPath
			const text = item.querySelector('.dimina-tabbar-text')
			const defaultIcon = item.querySelector('.dimina-tabbar-icon-default')
			const selectedIcon = item.querySelector('.dimina-tabbar-icon-selected')

			if (text) text.style.color = isSelected ? selectedColor : normalColor
			if (defaultIcon) defaultIcon.style.display = isSelected ? 'none' : 'block'
			if (selectedIcon) selectedIcon.style.display = isSelected ? 'block' : 'none'
			item.classList.toggle('dimina-tabbar-item--selected', isSelected)
		})
	}

  /**
   * Render TabBar UI
   */
  renderTabBar(tabBarConfig, currentPath) {
    console.log("📱 [renderTabBar] 开始渲染 TabBar");
    console.log("📱 [renderTabBar] tabBarConfig:", tabBarConfig);
    console.log("📱 [renderTabBar] currentPath:", currentPath);

    const tabBarEl = this.el.querySelector(".dimina-mini-app__tabbar");
    if (!tabBarEl) {
      console.error("❌ [renderTabBar] TabBar element not found!");
      return;
    }
    console.log("✅ [renderTabBar] TabBar 元素找到了");

    const { color, selectedColor, backgroundColor, borderStyle, list } =
      tabBarConfig;
    console.log("📱 [renderTabBar] TabBar 配置 - list.length:", list?.length);

    // Generate TabBar HTML
    const tabBarHTML = `
			<div class="dimina-tabbar" style="
				background-color: ${backgroundColor || "#ffffff"};
				border-top: 0.5px solid ${borderStyle === "white" ? "#ffffff" : "rgba(0, 0, 0, 0.2)"};
			">
				${list
          .map(
            (item, index) => `
					<div class="dimina-tabbar-item" data-path="${item.pagePath}" data-index="${index}">
						${
              item.iconPath
                ? `
							<img class="dimina-tabbar-icon dimina-tabbar-icon-default"
								src="${import.meta.env.BASE_URL}${this.appId}/main/${item.iconPath}"
								alt="${item.text}" />
							${
                item.selectedIconPath
                  ? `<img class="dimina-tabbar-icon dimina-tabbar-icon-selected"
									src="${import.meta.env.BASE_URL}${this.appId}/main/${item.selectedIconPath}"
									alt="${item.text}" />`
                  : ""
              }
						`
                : ""
            }
						<span class="dimina-tabbar-text" style="color: ${color || "#999999"};">
							${item.text}
						</span>
					</div>
				`,
          )
          .join("")}
			</div>
		`;

    tabBarEl.innerHTML = tabBarHTML;
    tabBarEl.style.display = "block";
    console.log("✅ [renderTabBar] TabBar HTML 已插入，display 设置为 block");

    // Adjust webviews container to make room for TabBar
    const webviewsContainer = this.el.querySelector(
      ".dimina-mini-app__webviews",
    );
    if (webviewsContainer) {
      webviewsContainer.style.bottom = "49px"; // Make room for TabBar
      console.log("✅ [renderTabBar] webviews bottom 设置为 49px");
    } else {
      console.warn("⚠️ [renderTabBar] webviews 容器未找到");
    }

    // Check if TabBar is visible
    const computedStyle = window.getComputedStyle(tabBarEl);
    console.log("📱 [renderTabBar] TabBar 样式检查:", {
      display: computedStyle.display,
      position: computedStyle.position,
      zIndex: computedStyle.zIndex,
      bottom: computedStyle.bottom,
      height: computedStyle.height,
    });

    // Bind click events
    const items = tabBarEl.querySelectorAll(".dimina-tabbar-item");
    console.log("📱 [renderTabBar] 查找到的 TabBar 项数量:", items.length);
    items.forEach((item, index) => {
      const path = item.getAttribute("data-path");
      console.log(
        `📱 [renderTabBar] 为 Tab ${index} 绑定点击事件, path:`,
        path,
      );

      item.addEventListener("click", (e) => {
        console.log(
          `🔘🔘🔘 [TabBar] ===== 点击事件触发 ===== Tab ${index}:`,
          path,
        );
        console.log("点击事件对象:", e);
        e.stopPropagation();
        this.switchTab({ url: `/${path}` });
      });

      // 添加鼠标悬停效果来测试元素是否可交互
      item.addEventListener("mouseenter", () => {
        console.log(`🖱️ [TabBar] 鼠标进入 Tab ${index}`);
      });
    });

    // Set initial selected state
    this.updateTabBarSelection(currentPath, color, selectedColor);

    // Test: Add a global click listener to the TabBar container
    tabBarEl.addEventListener("click", (e) => {
      console.log("🔥🔥🔥 [TabBar] TabBar 容器被点击了！", e.target);
    });

    console.log("✅✅✅ [renderTabBar] TabBar 渲染完成 ✅✅✅");
  }

  /**
   * Update TabBar selected state
   */
  updateTabBarSelection(currentPath, color, selectedColor) {
    const tabBarEl = this.el.querySelector(".dimina-mini-app__tabbar");
    if (!tabBarEl) return;

    const items = tabBarEl.querySelectorAll(".dimina-tabbar-item");
    const normalColor =
      color || this.appConfig?.app?.tabBar?.color || "#999999";
    const activeColor =
      selectedColor || this.appConfig?.app?.tabBar?.selectedColor || "#1890ff";

    items.forEach((item) => {
      const path = item.getAttribute("data-path");
      const isSelected = path === currentPath;
      const text = item.querySelector(".dimina-tabbar-text");
      const defaultIcon = item.querySelector(".dimina-tabbar-icon-default");
      const selectedIcon = item.querySelector(".dimina-tabbar-icon-selected");

      // Update text color
      if (text) {
        text.style.color = isSelected ? activeColor : normalColor;
      }

      // Update icon visibility
      if (defaultIcon) {
        defaultIcon.style.display = isSelected ? "none" : "block";
      }
      if (selectedIcon) {
        selectedIcon.style.display = isSelected ? "block" : "none";
      }

      // Update item class
      if (isSelected) {
        item.classList.add("dimina-tabbar-item--selected");
      } else {
        item.classList.remove("dimina-tabbar-item--selected");
      }
    });
  }

  navigateToMiniProgram(opts) {
    const { appId, path } = opts;
    AppManager.openApp(
      {
        appId,
        path,
        scene: 1037, // 打开小程序
      },
      this.parent,
    );
  }

  bindMoreEvent() {
    const moreBtn = this.el.querySelector(
      ".dimina-mini-app-navigation__actions-variable",
    );
    const dialog = this.el.querySelector(".dimina-mini-app_dialog-content");
    const overlay = this.el.querySelector(".dimina-mini-app_dialog-bg");
    const info = this.el.querySelector(".dimina-mini-app_dialog-info");
    info.innerHTML = `app id: ${this.appId}`;

    overlay.addEventListener("transitionend", () => {
      if (overlay.style.opacity === "0") {
        overlay.style.display = "none";
      }
    });

    moreBtn.onclick = () => {
      overlay.style.display = "block";
      overlay.style.opacity = 1;
      dialog.classList.add("show");
    };

    overlay.onclick = () => {
      overlay.style.opacity = 0;
      dialog.classList.remove("show");
    };
  }

  bindCloseEvent() {
    const closeBtn = this.el.querySelector(
      ".dimina-mini-app-navigation__actions-close",
    );

    closeBtn.onclick = () => {
      HashRouter.clear();
      AppManager.closeApp(this);
    };
  }

  destroy() {
    AppManager.popView();
    this.jscore.destroy();
  }

  /**
   * 获取网络类型
   * https://developers.weixin.qq.com/miniprogram/dev/api/device/network/wx.getNetworkType.html
   */
  getNetworkType(opts) {
    const { success } = opts;
    const onSuccess = this.createCallbackFunction(success);
    onSuccess?.({
      networkType: "wifi",
    });
  }

  /**
   * 发起 HTTPS 网络请求
   * https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html
   * @param {*} param0
   */
  request({
    url,
    data,
    header = {}, // 默认为空对象
    timeout = 0, // 默认为0，表示没有超时
    method = "GET", // 默认为GET方法
    dataType = "json", // 默认为json类型
    responseType = "text", // 响应的数据类型，默认为 text
    success,
    fail,
    complete,
  }) {
    // 创建一个AbortController实例
    // const controller = new AbortController();
    // const { signal } = controller;

    // 创建fetch请求的init对象
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        data,
        header,
        timeout,
        method,
        dataType,
        responseType,
      }),
    };

    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    fetch("http://localhost:7788/proxy", init)
      .then((response) => {
        if (!response.ok) {
          const error = new Error(response.statusText);
          error.code = response.status;
          throw error;
        }

        // Convert the Headers object to a plain object
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        switch (dataType) {
          case "json":
            return response
              .json()
              .then((data) => ({
                data: JSON.parse(data),
                header: headers,
                statusCode: response.status,
              }));
          case "arraybuffer":
            return response
              .arrayBuffer()
              .then((data) => ({
                data,
                header: headers,
                statusCode: response.status,
              }));
          default:
            return response
              .text()
              .then((data) => ({
                data,
                header: headers,
                statusCode: response.status,
              }));
        }
      })
      .then((data) => {
        onSuccess?.(data);
      })
      .catch((error) => {
        onFail?.({ errMsg: error.message, errno: error.code });
      })
      .finally(() => {
        onComplete?.();
      });

    // return { abort: controller.abort };
  }

  getSystemInfoAsync(opts) {
    const bar = this.parent.parent.root
      .querySelector(".iphone__status-bar")
      .getBoundingClientRect();
    const wb = this.parent.el
      .querySelector(".dimina-native-webview__root")
      .getBoundingClientRect();

    const { success, complete } = opts;

    const onSuccess = this.createCallbackFunction(success);
    const onComplete = this.createCallbackFunction(complete);

    onSuccess?.({
      statusBarHeight: bar.height,
      brand: "devtools",
      mode: "default",
      model: "web",
      platform: "devtools",
      system: "web",
      deviceOrientation: "portrait",
      SDKVersion: "3.0.0",
      language: "zh_CN",
      wifiEnabled: true,
      safeArea: {
        width: wb.width,
        height: wb.height,
        top: wb.top,
        bottom: wb.bottom,
        left: wb.left,
        right: wb.right,
      },
    });
    onComplete?.();
  }

  getMenuButtonBoundingClientRect() {
    return this.el
      .querySelector(".dimina-mini-app-navigation__actions")
      .getBoundingClientRect();
  }

  getSystemInfoSync() {
    return {
      brand: "devtools",
      model: "web",
      platform: "devtools",
      system: "web",
      SDKVersion: "3.0.0", // vant组件库 判断  canIUseModel version 需要大于 2.9.3
    };
  }

  showToast(opts) {
    const {
      title = "",
      duration = 1500,
      icon = "success",
      success,
      complete,
    } = opts;

    if (!title) {
      return;
    }

    this.hideToast({});

    const onSuccess = this.createCallbackFunction(success);
    const onComplete = this.createCallbackFunction(complete);

    this.toastInfo.dom = document.createElement("div");
    this.toastInfo.dom.classList.add("dimina-toast", `dimina-toast--${icon}`);
    this.toastInfo.dom.innerHTML = `<p>${title}</p>`;
    this.webviewsContainer.appendChild(this.toastInfo.dom);

    this.toastInfo.timer = setTimeout(() => {
      this.webviewsContainer.removeChild(this.toastInfo.dom);
      this.toastInfo.dom = null;
    }, duration);

    onSuccess?.();
    onComplete?.();
  }

  hideToast(opts) {
    const { success, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onComplete = this.createCallbackFunction(complete);

    if (this.toastInfo.dom) {
      this.webviewsContainer.removeChild(this.toastInfo.dom);
      this.toastInfo.dom = null;
    }
    if (this.toastInfo.timer) {
      clearTimeout(this.toastInfo.timer);
      this.toastInfo.timer = null;
    }
    onSuccess?.();
    onComplete?.();
  }

  showLoading(opts) {
    this.showToast({ ...opts, icon: "loading" });
  }

  hideLoading(opts) {
    this.hideLoading(opts);
  }

  showModal(opts) {
    const {
      content = "",
      cancelText = "取消",
      confirmText = "确定",
      success,
      complete,
    } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onComplete = this.createCallbackFunction(complete);

    // 遮罩层
    const mask = document.createElement("div");
    mask.className = "dimina-dialog-mask";
    // 弹窗内容
    const dialog = document.createElement("div");
    dialog.className = "dimina-dialog";
    dialog.innerHTML = `<p>${content}</p>
		<div>
			<a id="cancelBtn" class="dimina-dialog__button" href="javascript:">${cancelText}</a>
			<a id="confirmBtn" class="dimina-dialog__button" style="color: #576b95;" href="javascript:">${confirmText}</a>
    	</div>`;

    const cleanup = () => {
      mask.remove();
      dialog.remove();
    };

    dialog.querySelector("#cancelBtn").addEventListener("click", () => {
      cleanup();
      onSuccess?.({ cancel: true });
      onComplete?.();
    });
    dialog.querySelector("#confirmBtn").addEventListener("click", () => {
      cleanup();
      onSuccess?.({ confirm: true });
      onComplete?.();
    });
    mask.onclick = cleanup;

    this.webviewsContainer.appendChild(mask);
    this.webviewsContainer.appendChild(dialog);
    // 动画效果可选
    setTimeout(() => {
      mask.classList.add("show");
      dialog.classList.add("show");
    }, 10);
  }

  showActionSheet(opts) {
    const {
      itemList = [],
      itemColor = "#000",
      success,
      fail,
      complete,
    } = opts || {};
    if (!Array.isArray(itemList) || itemList.length === 0) {
      fail &&
        this.createCallbackFunction(fail)({ errMsg: "showActionSheet:fail" });
      complete && this.createCallbackFunction(complete)();
      return;
    }
    // 创建遮罩层
    const mask = document.createElement("div");
    mask.className = "dimina-action-sheet-mask";
    // 创建 action sheet 容器
    const sheet = document.createElement("div");
    sheet.className = "dimina-action-sheet";

    // 清理方法
    const cleanup = () => {
      mask.remove();
      sheet.remove();
    };
    // 选项
    itemList.forEach((item, idx) => {
      const btn = document.createElement("div");
      btn.className = "dimina-action-sheet-item";
      btn.style.color = itemColor;
      btn.textContent = item;
      btn.onclick = () => {
        cleanup();
        success && this.createCallbackFunction(success)({ tapIndex: idx });
        complete && this.createCallbackFunction(complete)();
      };
      sheet.appendChild(btn);
    });
    // 取消按钮
    const cancelBtn = document.createElement("div");
    cancelBtn.className = "dimina-action-sheet-cancel";
    cancelBtn.textContent = "取消";
    cancelBtn.onclick = () => {
      cleanup();
      fail &&
        this.createCallbackFunction(fail)({
          errMsg: "showActionSheet:fail cancel",
        });
      complete && this.createCallbackFunction(complete)();
    };
    sheet.appendChild(cancelBtn);

    mask.onclick = cleanup;
    // 挂载到 webviewsContainer
    this.webviewsContainer.appendChild(mask);
    this.webviewsContainer.appendChild(sheet);
    // 动画效果
    setTimeout(() => {
      sheet.classList.add("show");
      mask.classList.add("show");
    }, 10);
  }

  setNavigationBarTitle(opts) {
    const { title, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);
    try {
      const currentBridge = this.bridgeList[this.bridgeList.length - 1];
      const navigationTitle = currentBridge.webview.el.querySelector(
        ".dimina-native-webview__navigation-title",
      );
      if (navigationTitle) {
        navigationTitle.textContent = title || "";
        onSuccess?.({ errMsg: "setNavigationBarTitle:ok" });
      } else {
        onFail?.({
          errMsg: `setNavigationBarTitle:fail Navigation title element not found`,
        });
      }
    } catch (error) {
      onFail?.({ errMsg: `setNavigationBarTitle:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  setNavigationBarColor(opts) {
    const { frontColor, backgroundColor, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      const currentBridge = this.bridgeList[this.bridgeList.length - 1];
      const navigation = currentBridge.webview.el.querySelector(
        ".dimina-native-webview__navigation",
      );
      if (navigation) {
        // 设置前景色（文字颜色）
        if (frontColor) {
          navigation.querySelector(
            ".dimina-native-webview__navigation-title",
          ).style.color = frontColor;
        }
        // 设置背景色
        if (backgroundColor) {
          navigation.style.backgroundColor = backgroundColor;
        }
        onSuccess?.({ errMsg: "setNavigationBarColor:ok" });
      } else {
        onFail?.({
          errMsg: `setNavigationBarColor:fail Navigation element not found`,
        });
      }
    } catch (error) {
      onFail?.({ errMsg: `setNavigationBarColor:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  /**
   * 页面滚动到指定位置
   */
  pageScrollTo(opts) {
    const { scrollTop, duration = 300, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      const currentBridge = this.bridgeList[this.bridgeList.length - 1];
      const webviewRoot =
        currentBridge.webview.iframe.contentWindow.document.documentElement;
      if (webviewRoot) {
        webviewRoot.scrollTo({
          top: scrollTop,
          behavior: duration > 0 ? "smooth" : "auto",
        });

        // 模拟滚动动画时间
        setTimeout(() => {
          onSuccess?.({ errMsg: "pageScrollTo:ok" });
          onComplete?.();
        }, duration);
      } else {
        onFail?.({
          errMsg: `pageScrollTo:fail Webview root element not found`,
        });
        onComplete?.();
      }
    } catch (error) {
      onFail?.({ errMsg: `pageScrollTo:fail ${error.message}` });
      onComplete?.();
    }
  }

  /**
   * 设置剪贴板数据
   */
  setClipboardData(opts) {
    const { data, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      navigator.clipboard
        .writeText(data)
        .then(() => {
          onSuccess?.({ errMsg: "setClipboardData:ok" });
          onComplete?.();
        })
        .catch((error) => {
          onFail?.({ errMsg: `setClipboardData:fail ${error.message}` });
          onComplete?.();
        });
    } catch (error) {
      onFail?.({ errMsg: `setClipboardData:fail ${error.message}` });
      onComplete?.();
    }
  }

  /**
   * 获取剪贴板数据
   */
  getClipboardData(opts) {
    const { success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      navigator.clipboard
        .readText()
        .then((data) => {
          onSuccess?.({ data, errMsg: "getClipboardData:ok" });
          onComplete?.();
        })
        .catch((error) => {
          onFail?.({ errMsg: `getClipboardData:fail ${error.message}` });
          onComplete?.();
        });
    } catch (error) {
      onFail?.({ errMsg: `getClipboardData:fail ${error.message}` });
      onComplete?.();
    }
  }

  setStorage(opts) {
    const { key, data, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      // 按appId区分存储数据
      const storageKey = `${this.appId}_${key}`;
      // 将数据转为字符串存储
      const dataString =
        typeof data === "object" ? JSON.stringify(data) : String(data);
      localStorage.setItem(storageKey, dataString);
      onSuccess?.({ errMsg: "setStorage:ok" });
    } catch (error) {
      onFail?.({ errMsg: `setStorage:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  getStorage(opts) {
    const { key, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      // 按appId区分存储数据
      const storageKey = `${this.appId}_${key}`;
      const data = localStorage.getItem(storageKey);
      if (data !== null) {
        // 尝试解析JSON数据
        let parsedData = data;
        try {
          parsedData = JSON.parse(data);
        } catch {
          // 如果解析失败，保持原始字符串
        }
        onSuccess?.({ data: parsedData, errMsg: "getStorage:ok" });
      } else {
        onFail?.({ errMsg: `getStorage:fail data not found` });
      }
    } catch (error) {
      onFail?.({ errMsg: `getStorage:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  removeStorage(opts) {
    const { key, success, fail, complete } = opts;
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      // 按appId区分存储数据
      const storageKey = `${this.appId}_${key}`;
      if (localStorage.getItem(storageKey) !== null) {
        localStorage.removeItem(storageKey);
        onSuccess?.({ errMsg: "removeStorage:ok" });
      } else {
        // 即使key不存在也返回成功
        onSuccess?.({ errMsg: "removeStorage:ok" });
      }
    } catch (error) {
      onFail?.({ errMsg: `removeStorage:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  clearStorage(opts) {
    const { success, fail, complete } = opts || {};
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      // 只清除当前appId的存储数据
      const appIdPrefix = `${this.appId}_`;
      const keysToRemove = [];

      // 找出所有属于当前appId的keys
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(appIdPrefix)) {
          keysToRemove.push(key);
        }
      }

      // 删除所有找到的keys
      keysToRemove.forEach((key) => localStorage.removeItem(key));

      onSuccess?.({ errMsg: "clearStorage:ok" });
    } catch (error) {
      onFail?.({ errMsg: `clearStorage:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }

  getStorageInfo(opts) {
    const { success, fail, complete } = opts || {};
    const onSuccess = this.createCallbackFunction(success);
    const onFail = this.createCallbackFunction(fail);
    const onComplete = this.createCallbackFunction(complete);

    try {
      const keys = [];
      let currentSize = 0;
      const limitSize = 10 * 1024 * 1024; // 假设限制为10MB
      const appIdPrefix = `${this.appId}_`;

      // 只获取当前appId的存储信息
      for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i);

        // 只处理当前appId的keys
        if (fullKey.startsWith(appIdPrefix)) {
          // 移除appId前缀，返回原始key给小程序
          const originalKey = fullKey.substring(appIdPrefix.length);
          keys.push(originalKey);

          const item = localStorage.getItem(fullKey);
          currentSize += item ? item.length * 2 : 0; // 估算字符串大小（UTF-16编码每个字符2字节）
        }
      }

      onSuccess?.({
        keys,
        currentSize, // 当前占用空间，单位为字节
        limitSize, // 存储限制，单位为字节
        errMsg: "getStorageInfo:ok",
      });
    } catch (error) {
      onFail?.({ errMsg: `getStorageInfo:fail ${error.message}` });
    } finally {
      onComplete?.();
    }
  }
}
