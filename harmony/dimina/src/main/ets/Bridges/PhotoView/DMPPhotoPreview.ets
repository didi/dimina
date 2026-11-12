import { PhotoView } from '@ohos/photoview';
import { fileUri } from '@kit.CoreFileKit';
import { DMPWindowUtil } from '../../Utils/DMPWindowUtils';
import { DMPApp } from '../../DApp/DMPApp';
import { display } from '@kit.ArkUI';
import { DRouter } from '../../Navigator/DRouter';
import { DMPMap } from '../../Utils/DMPMap';

class DMPMediaPreviewItem {
  url: string;
  type: string;
  poster: string;

  constructor(url: string, type: string, poster: string = '') {
    this.url = url;
    this.type = type;
    this.poster = poster;
  }
}

@Component
export struct DMPPhotoPreview {
  @Prop uri: string
  @Prop param: Map<string, Object>
  @State mediaSources: Array<DMPMediaPreviewItem> = []
  private swipeController = new SwiperController()
  private imageModels: Array<PhotoView.Model> = []
  private videoControllers: Array<VideoController> = []
  private defaultIndex: number = this.param?.get('index') as number
  private realHeight = 0

  static ROUTE_NAME = 'onetravel://dimina/photopreview'

  aboutToAppear(): void {
    const rawSources = this.param?.get('sources') as Array<Object> | undefined;
    if (rawSources && rawSources.length > 0) {
      rawSources.forEach((raw: Object) => {
        const item = raw instanceof DMPMap ? raw : new DMPMap(raw);
        const url = item.getString('url') ?? '';
        if (url) {
          this.mediaSources.push(new DMPMediaPreviewItem(
            url,
            item.getString('type') === 'video' ? 'video' : 'image',
            item.getString('poster') ?? '',
          ));
        }
      });
    } else {
      const imageUrls = this.param?.get('urls') as Array<string> | undefined;
      imageUrls?.forEach((url: string) => this.mediaSources.push(new DMPMediaPreviewItem(url, 'image')));
    }

    this.mediaSources.forEach((item: DMPMediaPreviewItem) => {
      const data = new PhotoView.Model();
      if (item.type === 'image') {
        data.setImageURI(item.url.startsWith('/') ? fileUri.getUriFromPath(item.url) : item.url)
          .setScale(1, false)
          .setImageFit(ImageFit.Contain)
          .setZoomable(false)
          .setMaximumScale(1.5)
          .setMinimumScale(0.8)
      }
      this.imageModels.push(data);
      this.videoControllers.push(new VideoController());
    })
    const screentHeight = display.getDefaultDisplaySync().height
    const vpHidth = px2vp(screentHeight)
    this.realHeight = vpHidth - 55 - px2vp(DMPWindowUtil.getTopSafeArea(DMPApp.getWindowStage()))
  }

  @Builder
  build() {
    NavDestination() {
      Column() {
        Column() {
          Blank()
            .height(px2vp(DMPWindowUtil.getTopSafeArea(DMPApp.getWindowStage())))
          Stack() {
            Text('图片预览')
              .height('100%')
              .width('100%')
              .fontSize(18)
              .fontColor('#000000')
              .fontWeight('500')
              .textAlign(TextAlign.Center)
            Image($r('app.media.ic_dmp_back_black'))
              .width(55)
              .height('100%')
              .padding(15)
              .align(Alignment.Start)
              .onClick((event?: ClickEvent) => {

                DRouter.getInstance().pop();
              })
          }
          .width('100%')
          .height('55')
          .alignContent(Alignment.Start)
        }.width('100%')
        .backgroundColor('#ffffff')

        Swiper(this.swipeController) {
          ForEach(this.mediaSources, (item: DMPMediaPreviewItem, index: number) => {
            if (item.type === 'video') {
              Video({
                src: item.url,
                previewUri: item.poster,
                controller: this.videoControllers[index],
              })
                .width('100%')
                .height('100%')
                .controls(true)
                .objectFit(ImageFit.Contain)
            } else {
              PhotoView({ model: this.imageModels[index] })
            }
          }, (item: DMPMediaPreviewItem, index: number) => `${index}:${item.url}`)
        }
        .index(this.defaultIndex)
        .cachedCount(2)
        .loop(true)
        .width('100%')
        .height(this.realHeight)
        .padding({
          bottom: 30,
        })
      }
    }.hideTitleBar(true)

  }
}
