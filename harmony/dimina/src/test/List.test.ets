import localUnitTest from './LocalUnit.test';
import menuButtonGeometryTest from './MenuButtonGeometry.test';
import dmpPageRecordRouterOwnershipTest from './DMPPageRecordRouterOwnership.test';

export default function testsuite() {
  localUnitTest();
  menuButtonGeometryTest();
  dmpPageRecordRouterOwnershipTest();
}
