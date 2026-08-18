import { HashMap } from '@kit.ArkTS';
import { DialogApi } from './DialogApi';
import { ModalOption } from './DMPCommonDialog';
import { systemDateTime } from '@kit.BasicServicesKit';


export type Observer = (data: string) => void;

export class DialogEventManager {
  private static instance: DialogEventManager;
  private events: HashMap<string, Observer> = new HashMap<string, Observer>();

  private constructor() {
  }

  public static getInstance(): DialogEventManager {
    if (!DialogEventManager.instance) {
      DialogEventManager.instance = new DialogEventManager();
    }
    return DialogEventManager.instance;
  }

  register(eventName: string, observer: Observer) {
    this.events.set(eventName, observer)
  }

  unRegister(eventName: string) {
    this.events.remove(eventName);
  }

  sendEvent(eventName: string, data: string) {
    this.events.get(eventName)?.(data);
  }
}

export class DialogManager {
  private static instance: DialogManager;
  private dialogs: HashMap<string, DialogApi> = new HashMap<string, DialogApi>();

  private constructor() {
  }

  public static getInstance(): DialogManager {
    if (!DialogManager.instance) {
      DialogManager.instance = new DialogManager();
    }
    return DialogManager.instance;
  }


  showDialog(params: ModalOption, dialogId?: string) {
    const resolvedDialogId: string = dialogId ?? "id" + systemDateTime.getTime()
    if (this.dialogs.hasKey(resolvedDialogId)) {
      this.hideDialog(resolvedDialogId)
    }

    const cancel = params.cancel
    const confirm = params.confirm
    const fail = params.fail
    params.cancel = () => {
      this.dialogs.remove(resolvedDialogId)
      cancel?.()
    }
    params.confirm = () => {
      this.dialogs.remove(resolvedDialogId)
      confirm?.()
    }
    params.fail = () => {
      this.dialogs.remove(resolvedDialogId)
      fail?.()
    }

    const dialog = new DialogApi();
    params.dialogId = resolvedDialogId;
    this.dialogs.set(params.dialogId, dialog);
    dialog.showDialog(params);
  }

  hideDialog(dialogId: string) {
    const dialog = this.dialogs.remove(dialogId);
    if (dialog) {
      dialog.hideDialog(dialogId);
    }
  }
}
