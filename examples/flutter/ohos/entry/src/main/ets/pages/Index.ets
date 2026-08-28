import { common } from '@kit.AbilityKit';
import { FlutterPage } from '@ohos/flutter_ohos';
import { DMPPage, DMPPhotoPreview } from '@didi-dimina/dimina';
import { DiminaFlutterHost } from '../host/DiminaFlutterHost';

const storage = LocalStorage.getShared();

@Entry(storage)
@Component
struct Index {
  private pageInfos: NavPathStack = new NavPathStack();
  @LocalStorageLink('viewId') viewId: string = '';

  aboutToAppear(): void {
    DiminaFlutterHost.attach(
      getContext(this) as common.UIAbilityContext,
      this.pageInfos
    );
  }

  build() {
    Navigation(this.pageInfos) {
      FlutterPage({ viewId: this.viewId });
    }
    .hideBackButton(true)
    .hideToolBar(true)
    .hideTitleBar(true)
    .navDestination(this.routerFactory);
  }

  @Builder
  routerFactory(name: string, paramMap: Map<string, Object>) {
    if (name === DMPPage.ROUTE_NAME) {
      DMPPage({ uri: name, param: paramMap });
    } else if (name === DMPPhotoPreview.ROUTE_NAME) {
      DMPPhotoPreview({ uri: name, param: paramMap });
    }
  }
}
