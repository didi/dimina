import window from '@ohos.window';
import { BusinessError } from '@kit.BasicServicesKit';
import { DMPLogger } from '../EventTrack/DMPLogger';

/**
 * 修改状态栏颜色
 */
export class DMPWindowUtil {
  public static getWindowBottomSafeArea(windowStage: window.WindowStage, bottomSafeArea: boolean): number {
    let bottomSafeHeight = -1;
    if (!bottomSafeArea) {
      bottomSafeHeight = 0
      return bottomSafeHeight
    }
    bottomSafeHeight = DMPWindowUtil.getBottomSafeArea(windowStage)
    return bottomSafeHeight
  }

  public static setWindowBarDarkMode(context: Context, isDark: boolean) {
    let windowClass: window.Window | undefined = undefined;
    try {
      window.getLastWindow(context, (err: BusinessError, data) => {
        const errCode: number = err.code
        if (errCode) {
          DMPLogger.e('', 'Failed to obtain the top window. Cause: ' + JSON.stringify(err));
          return
        }
        windowClass = data

        if (windowClass) {

          let properties: window.SystemBarProperties = {
            statusBarColor: '#00ffffff',
            navigationBarColor: '#00ffffff',
            //以下两个属性从API Version8开始支持
            statusBarContentColor: isDark ? '#000000' : '#ffffff',
            navigationBarContentColor: '#ffffff'
          }
          windowClass.setWindowSystemBarProperties(properties, (err: BusinessError) => {
            const errCode: number = err.code;
            if (errCode) {
              DMPLogger.e('', 'Failed to set the system bar properties. Cause: ' + JSON.stringify(err));
              return;
            }
            DMPLogger.i('', 'Succeeded in setting the system bar properties.');
          })
        }

      })
    } catch (e) {
    }
  }

  /**
   * 系统返回的单位应该是px
   *
   * @param _windowStage
   * @returns
   */
  public static getBottomSafeArea(_windowStage: window.WindowStage): number {
    let windowClass: window.Window = _windowStage.getMainWindowSync(); // 获取应用主窗口
    // 2. 获取布局避让遮挡的区域
    let type = window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR; // 以导航条避让为例
    let avoidArea = windowClass.getWindowAvoidArea(type);
    return avoidArea.bottomRect.height; // 获取到导航条区域的高度
  }

  /**
   * 系统返回的单位应该是px
   *
   * @param _windowStage
   * @returns
   */
  public static getTopSafeArea(_windowStage: window.WindowStage): number {
    let windowClass: window.Window = _windowStage.getMainWindowSync(); // 获取应用主窗口
    // 2. 获取布局避让遮挡的区域
    let type = window.AvoidAreaType.TYPE_SYSTEM; // 以导航条避让为例

    let avoidAreaTop = windowClass.getWindowAvoidArea(type);
    const heightTop = avoidAreaTop.topRect.height; // 获取到导航条区域的高度
    DMPLogger.d("DMPPage", "system height top ->" + heightTop)

    return heightTop
  }
}
