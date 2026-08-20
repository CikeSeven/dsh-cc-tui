/** Internal trajectory SceneV2 wiring (WP-08e1). */
import type { TerminalProfile } from '../terminal/profile.js'
import type { SceneCapabilityContext, SceneDescriptorV2, SceneV2 } from './contract.js'
import type { TrajectoryController } from '../controllers/trajectory.js'
import { createTrajectoryScene } from '../components/trajectory/scene.js'

export function createTrajectorySceneDescriptor(
  controller: TrajectoryController,
  profile: TerminalProfile,
  degradedNotice?: string,
): SceneDescriptorV2 {
  return {
    apiVersion: '2',
    id: 'trajectory',
    title: 'Trajectory',
    requiredGrants: [],
    commands: [],
    create(context: SceneCapabilityContext): SceneV2 {
      controller.bindClose(() => { void context.close('user') })
      return {
        apiVersion: '2',
        sceneId: 'trajectory',
        focused: true,
        render(_view, width) {
          const view = controller.view()
          const effective = degradedNotice === undefined || view.degradedNotice !== undefined
            ? view
            : { ...view, degradedNotice }
          return createTrajectoryScene(effective, profile).render(width)
        },
        handleInput(event) {
          controller.handleInput(event)
        },
        invalidate() {
          controller.invalidate()
        },
        onClose() {
          controller.bindClose(null)
        },
        cursor: undefined,
      }
    },
  }
}
