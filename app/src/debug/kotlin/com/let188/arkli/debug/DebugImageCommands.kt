package com.let188.arkli.debug

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import android.util.Log
import android.webkit.WebView
import java.io.File
import java.io.FileOutputStream
import java.util.Random

/** 调试日志 tag，与 DebugHooksProvider 保持一致 */
private const val TAG = "ArkliDebug"

/** 夹具目录（相对 `cacheDir/arkli`），页面路径为 `cache/pick/dbg/<name>` */
private const val PICK_DBG = "pick/dbg"

/** 成品目录（相对 `cacheDir/arkli`） */
private const val OUT_DIR = "out"

/** 带 EXIF 方向的夹具宽高：存储为 400x200，方向 6（顺时针 90 度），显示应为 200x400 */
private const val ORIENT_W = 400
private const val ORIENT_H = 200

/**
 * 图片压缩的真机验证命令，仅 debug 源集。
 * - `imgprep`：生成夹具（透明图标、平滑渐变 PNG、带 EXIF 方向的 JPEG、损坏文件）；真实大照片由 adb 另行拷到 `real.jpg`
 * - `imgrun [--es path <名字片段>]`：在页面里依次调用（可只跑名字含该片段的场景） `native.image.compress`，结果以 `DBGIMG` 前缀输出到 console
 * - `exifdump --es path <页面路径>`：打印缓存文件的 EXIF 标签与尺寸
 * - `imglist`：列出成品目录
 * - `nav --es path /tool/image-compress`：把页面路由切到指定 hash 路径
 */
object DebugImageCommands {
    /**
     * 处理一条图片调试命令。
     *
     * @param cmd 命令名
     * @param ctx 上下文
     * @param wv 页面 WebView
     * @param path exifdump 用的页面路径
     */
    fun handle(cmd: String, ctx: Context, wv: WebView, path: String?) {
        val root = File(ctx.cacheDir, "arkli")
        when (cmd) {
            "imgprep" -> prepare(File(root, PICK_DBG).apply { mkdirs() })
            "imgrun" -> DebugFileCommands.js(wv, "var ONLY=" + org.json.JSONObject.quote(path ?: "") + ";" + SCENARIO_JS)
            "nav" -> wv.evaluateJavascript("location.hash=" + org.json.JSONObject.quote("#" + (path ?: "/")), null)
            "exifdump" -> dump(File(root, path?.removePrefix("cache/") ?: ""))
            "imglist" -> Log.i(
                TAG,
                "成品目录：\n" + File(root, OUT_DIR).walkTopDown().filter { it.isFile }
                    .joinToString("\n") { "${it.name} ${it.length()}" },
            )
        }
    }

    /** 生成夹具 */
    private fun prepare(dir: File) {
        // 带透明的图标：透明底 + 实心圆 + 半透明描边
        val icon = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        Canvas(icon).apply {
            val p = Paint(Paint.ANTI_ALIAS_FLAG)
            p.color = Color.argb(128, 229, 57, 53)
            drawCircle(128f, 128f, 92f, p)
            p.color = Color.rgb(229, 57, 53)
            drawCircle(128f, 128f, 76f, p)
        }
        FileOutputStream(File(dir, "icon.png")).use { icon.compress(Bitmap.CompressFormat.PNG, 100, it) }
        icon.recycle()
        // 平滑渐变 PNG（缩色可能反而变大的样本）
        val grad = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888)
        val gp = IntArray(512 * 512) { Color.rgb((it % 512) / 2, (it / 512) / 2, ((it % 512) + (it / 512)) / 4) }
        grad.setPixels(gp, 0, 512, 0, 0, 512, 512)
        FileOutputStream(File(dir, "gradient.png")).use { grad.compress(Bitmap.CompressFormat.PNG, 100, it) }
        grad.recycle()
        // 带 EXIF 方向与拍摄信息的 JPEG：左半红、右半蓝，便于看方向
        val o = Bitmap.createBitmap(ORIENT_W, ORIENT_H, Bitmap.Config.ARGB_8888)
        val c = Canvas(o)
        c.drawColor(Color.RED)
        c.drawRect(ORIENT_W / 2f, 0f, ORIENT_W.toFloat(), ORIENT_H.toFloat(), Paint().apply { color = Color.BLUE })
        val of = File(dir, "orient.jpg")
        FileOutputStream(of).use { o.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        o.recycle()
        ExifInterface(of.path).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setAttribute(ExifInterface.TAG_MAKE, "ArkliCam")
            setAttribute(ExifInterface.TAG_MODEL, "Dbg-1")
            setAttribute(ExifInterface.TAG_DATETIME, "2026:10:13 12:00:00")
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "14/1,35/1,0/1")
            setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "121/1,0/1,0/1")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            saveAttributes()
        }
        // 损坏文件：随机字节冒充 jpg
        File(dir, "bad.jpg").writeBytes(ByteArray(2000).also { Random(7).nextBytes(it) })
        Log.i(TAG, "图片夹具已生成：" + dir.list()?.sorted())
    }

    /** 打印缓存文件的尺寸与 EXIF 标签 */
    private fun dump(f: File) {
        val b = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(f.path, b)
        val e = ExifInterface(f.path)
        val tags = listOf(
            ExifInterface.TAG_ORIENTATION, ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_DATETIME,
            ExifInterface.TAG_GPS_LATITUDE, ExifInterface.TAG_GPS_LONGITUDE,
        ).joinToString(" ") { "$it=${e.getAttribute(it)}" }
        Log.i(TAG, "EXIF ${f.name} ${b.outWidth}x${b.outHeight} size=${f.length()} $tags")
    }
}

/**
 * 页面里跑的验证脚本。注意：Kotlin 原始字符串里不能出现美元符号加标识符，脚本没用模板字符串。
 * 每步输出 `DBGIMG <名> ms=<耗时> ...`；进度事件输出 `DBGIMG EVT`。
 */
private const val SCENARIO_JS = """
(async function(){
 var D='cache/pick/dbg/', ev=0;
 if(!window.__imgEv){window.__imgEv=1;window.ArkliNative.addEventListener('message',function(e){
  var m=JSON.parse(e.data); if(m.event==='image.progress'){ev++;console.log('DBGIMG EVT '+JSON.stringify(m.data));}});}
 function it(n){return {path:D+n,name:n};}
 async function T(name,params,cancelAfter){
  if(ONLY&&name.indexOf(ONLY)<0)return;
  var t0=Date.now(), id='js-'+(window.__n+1), p=__rpc('native.image.compress',params);
  if(cancelAfter){setTimeout(function(){window.ArkliNative.postMessage(JSON.stringify({v:2,id:'c-'+id,method:'native.task.cancel',params:{id:id}}));},cancelAfter);}
  var m=await p, ms=Date.now()-t0;
  if(!m.ok){console.log('DBGIMG '+name+' ms='+ms+' ERROR '+m.error.code+' '+m.error.message);return m;}
  var s=m.data.items.map(function(r){return r.path.split('/').pop()+' '+r.width+'x'+r.height+' bytes='+r.bytes+' src='+r.srcBytes+' ratio='+r.ratio.toFixed(3)+(r.targetReached===undefined?'':' reached='+r.targetReached);}).join(' | ');
  var f=m.data.failed.map(function(x){return x.index+':'+x.code+':'+x.message;}).join(' | ');
  console.log('DBGIMG '+name+' ms='+ms+' OK '+s+(f?' FAILED['+f+']':''));return m;}
 await T('jpeg-q80',{items:[it('real.jpg')],format:'jpeg',quality:80});
 await T('jpeg-q40',{items:[it('real.jpg')],format:'jpeg',quality:40});
 await T('jpeg-edge1080',{items:[it('real.jpg')],format:'jpeg',quality:80,maxEdge:1080});
 await T('jpeg-target300k',{items:[it('real.jpg')],format:'jpeg',quality:95,maxEdge:2048,targetBytes:300000});
 await T('jpeg-target-unreachable',{items:[it('real.jpg')],format:'jpeg',quality:95,maxEdge:2048,targetBytes:1000});
 await T('webp-q80',{items:[it('real.jpg')],format:'webp',quality:80,maxEdge:2048});
 await T('webp-alpha',{items:[it('icon.png')],format:'webp',quality:80});
 await T('jpeg-alpha-flat',{items:[it('icon.png')],format:'jpeg',quality:90});
 await T('png-lossless-icon',{items:[it('icon.png')],format:'png',png:{mode:'lossless'}});
 await T('png-palette-icon',{items:[it('icon.png')],format:'png',png:{mode:'palette',colors:16}});
 await T('png-lossless-gradient',{items:[it('gradient.png')],format:'png',png:{mode:'lossless'}});
 await T('png-palette-gradient',{items:[it('gradient.png')],format:'png',png:{mode:'palette',colors:256}});
 await T('png-lossless-photo',{items:[it('real.jpg')],format:'png',maxEdge:1200,png:{mode:'lossless'}});
 await T('png-palette-photo',{items:[it('real.jpg')],format:'png',maxEdge:1200,png:{mode:'palette',colors:256}});
 await T('png-palette-photo-dither',{items:[it('real.jpg')],format:'png',maxEdge:1200,png:{mode:'palette',colors:64,dither:true}});
 await T('png-12mp-full',{items:[it('real.jpg')],format:'png',png:{mode:'lossless'}});
 await T('exif-orient',{items:[it('orient.jpg')],format:'jpeg',quality:90});
 await T('exif-keep',{items:[it('orient.jpg')],format:'jpeg',quality:90,keepExif:true});
 await T('batch-partial',{items:[it('real.jpg'),it('bad.jpg'),it('icon.png')],format:'webp',maxEdge:800});
 await T('bad-missing-path',{items:[it('real.jpg'),it('nope.jpg')],format:'jpeg'});
 await T('bad-traversal',{items:[{path:'cache/pick/../../x'}],format:'jpeg'});
 await T('bad-format',{items:[it('real.jpg')],format:'gif'});
 await T('bad-quality',{items:[it('real.jpg')],format:'jpeg',quality:0});
 var five=[];for(var i=0;i<8;i++)five.push(it('real.jpg'));
 var before=ev;
 await T('batch-8-progress',{items:five,format:'jpeg',maxEdge:1600});
 console.log('DBGIMG progress events='+(ev-before));
 var mix=[it('icon.png'),it('icon.png'),it('icon.png'),it('real.jpg'),it('real.jpg')];
 await T('cancel-after-some-written',{items:mix,format:'png',png:{mode:'palette',colors:256}},1200);
 await T('cancel-mid-batch',{items:five,format:'png',png:{mode:'palette',colors:256}},2500);
 console.log('DBGIMG DONE');
})();
"""
