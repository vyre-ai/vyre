// The camera permission and the live QR view. Nothing leaves the phone: each frame is read in
// memory and dropped, and only the text of a code reaches the app.

package sh.vyre.scan

import android.Manifest
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VyreScanModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VyreScan")

    AsyncFunction("getPermission") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.CAMERA)
    }

    View(VyreScanView::class) {
      Events("onCode")
    }
  }
}
