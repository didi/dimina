import localUnitTest from './LocalUnit.test';
import menuButtonGeometryTest from './MenuButtonGeometry.test';
import dmpPageRecordRouterOwnershipTest from './DMPPageRecordRouterOwnership.test';
import dmpWebSocketValidationTest from './DMPWebSocketValidationTest.test';
import dmpWebSocketManagerTest from './DMPWebSocketManagerTest.test';
import dmpWebSocketGlobalListenerReplayTest from './DMPWebSocketGlobalListenerReplayTest.test';
import dmpWebSocketDiminaBehaviorTest from './DMPWebSocketDiminaBehaviorTest.test';
import dmpWebSocketJourneyBehaviorTest from './DMPWebSocketJourneyBehaviorTest.test';
import dmpWebSocketSettlerAndHeaderBehaviorTest from './DMPWebSocketSettlerAndHeaderBehaviorTest.test';

export default function testsuite() {
  localUnitTest();
  menuButtonGeometryTest();
  dmpPageRecordRouterOwnershipTest();
  dmpWebSocketValidationTest();
  dmpWebSocketManagerTest();
  dmpWebSocketGlobalListenerReplayTest();
  dmpWebSocketDiminaBehaviorTest();
  dmpWebSocketJourneyBehaviorTest();
  dmpWebSocketSettlerAndHeaderBehaviorTest();
}
