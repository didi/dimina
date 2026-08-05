import localUnitTest from './LocalUnit.test';
import menuButtonGeometryTest from './MenuButtonGeometry.test';
import dmpPageRecordRouterOwnershipTest from './DMPPageRecordRouterOwnership.test';
import dmpWebSocketValidationTest from './DMPWebSocketValidationTest.test';
import dmpWebSocketManagerTest from './DMPWebSocketManagerTest.test';

export default function testsuite() {
  localUnitTest();
  menuButtonGeometryTest();
  dmpPageRecordRouterOwnershipTest();
  dmpWebSocketValidationTest();
  dmpWebSocketManagerTest();
}
