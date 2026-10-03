package sh.vyre.scan

import android.content.Context
import android.view.View
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** The back camera, drawn full size, reading QR codes. Sends onCode { data } for each frame that holds one. */
class VyreScanView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCode by EventDispatcher()
  private val preview = PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
  private val worker: ExecutorService = Executors.newSingleThreadExecutor()
  private var provider: ProcessCameraProvider? = null
  private val reader = MultiFormatReader().apply {
    setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
  }

  init {
    addView(preview, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  // React Native lays out only its own children: size the preview ourselves.
  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    preview.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
    preview.layout(0, 0, w, h)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      val p = future.get()
      provider = p
      val view = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
      val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
        .also { it.setAnalyzer(worker, ::read) }
      p.unbindAll()
      try {
        p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, view, analysis)
      } catch (_: Exception) {
        // No back camera, or the camera is busy: the screen shows an empty view and the person can paste the link.
      }
    }, ContextCompat.getMainExecutor(context))
  }

  override fun onDetachedFromWindow() {
    provider?.unbindAll()
    provider = null
    super.onDetachedFromWindow()
  }

  private fun read(image: ImageProxy) {
    try {
      // ZXing reads a code at any rotation, so the luminance plane goes in as it comes.
      val plane = image.planes[0]
      val buf = plane.buffer
      val row = plane.rowStride
      val data = ByteArray(buf.remaining()).also { buf.get(it) }
      val source = PlanarYUVLuminanceSource(data, row, image.height, 0, 0, image.width, image.height, false)
      val text = try { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text } catch (_: NotFoundException) { null }
      reader.reset()
      if (text != null) onCode(mapOf("data" to text))
    } catch (_: Exception) {
      // A frame that cannot be read is skipped.
    } finally {
      image.close()
    }
  }
}
