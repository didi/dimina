export class DMPCapsuleAppearance {
  backgroundOverride: ResourceColor | undefined = undefined
  iconOverride: ResourceColor | undefined = undefined

  backgroundColor(whiteForeground: boolean): ResourceColor {
    return this.backgroundOverride ?? (whiteForeground ? '#26000000' : '#99ffffff')
  }

  iconColor(whiteForeground: boolean): ResourceColor {
    return this.iconOverride ?? (whiteForeground ? '#ffffff' : '#1f1f1f')
  }
}
