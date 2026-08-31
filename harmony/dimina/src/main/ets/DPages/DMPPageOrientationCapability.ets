/** Host capability gate shared by initialization and tests. Only the literal true opts in. */
export class DMPPageOrientationCapability {
  static isEnabled(value: boolean | undefined): boolean {
    return value === true
  }
}
