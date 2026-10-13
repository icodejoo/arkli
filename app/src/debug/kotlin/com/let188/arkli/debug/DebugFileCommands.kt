package com.let188.arkli.debug

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.util.Log
import android.webkit.WebView
import com.let188.arkli.files.FileConst
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** 调试日志 tag，与 DebugHooksProvider 保持一致 */
private const val TAG = "ArkliDebug"

/** 缓存里放调试夹具的子目录（相对 `cacheDir/arkli`） */
private const val FIXTURE_DIR = "out/dbg"

/** Range 夹具文件名 */
private const val RANGE_FILE = "range.bin"

/** Range 夹具大小（1MB） */
private const val RANGE_SIZE = 1 shl 20

/**
 * 页面侧的小型 RPC 脚本：给 `window.__rpc(method, params)` 返回 Promise，
 * 结果走 `console.log('DBGRESULT ...')`，在 logcat 的 chromium 标签里看。
 * 注意：Kotlin 原始字符串里不能出现美元符号加标识符，脚本里没用模板字符串。
 */
private const val JS_PRELUDE = """
if(!window.__rpcInit){window.__rpcInit=1;window.__pend={};window.__n=0;
 window.ArkliNative.addEventListener('message',function(e){var m=JSON.parse(e.data);
  if(m.id&&window.__pend[m.id]){window.__pend[m.id](m);delete window.__pend[m.id];}});
 window.__rpc=function(method,params){return new Promise(function(res){var id='js-'+(++window.__n);
  window.__pend[id]=res;window.ArkliNative.postMessage(JSON.stringify({v:2,id:id,method:method,params:params}));});};
 window.__hex=function(buf){return Array.prototype.map.call(new Uint8Array(buf),function(b){return ('0'+b.toString(16)).slice(-2)}).join('');};
 window.__latin1=function(u8){var s='';for(var i=0;i<u8.length;i+=8192){s+=String.fromCharCode.apply(null,u8.subarray(i,Math.min(i+8192,u8.length)));}return s;};
 window.__log=function(){console.log('DBGRESULT '+Array.prototype.join.call(arguments,' '));};
}
"""

/** 调试用的文件能力命令，仅 debug 源集 */
object DebugFileCommands {
    /**
     * 处理一条文件相关命令。
     *
     * @param cmd 命令名：filepick / filesave / writetest / writeopen / rangetest / listcache
     * @param ctx 上下文，取缓存目录
     * @param wv 页面 WebView
     * @param mime filepick 用的 mime 过滤
     * @param multiple filepick 是否多选
     * @param mb writetest 的数据量（MB）
     * @param enc writetest 的帧编码
     * @param send 往页面通道发请求的函数，参数依次为方法名与 params JSON
     * @return 命令被处理返回 true
     */
    fun handle(
        cmd: String, ctx: Context, wv: WebView, mime: String?, multiple: Boolean, mb: Int, enc: String,
        send: (String, String) -> Unit,
    ): Boolean {
        when (cmd) {
            "filepick" -> send("native.file.pick", JSONObject().put("mime", mime ?: FileConst.MIME_IMAGE).put("multiple", multiple).toString())
            "filesave" -> {
                val name = makePng(ctx)
                val item = JSONObject().put("path", "cache/$FIXTURE_DIR/$name")
                send("native.file.save", JSONObject().put("items", org.json.JSONArray().put(item)).toString())
            }
            "writetest" -> js(wv, writeTestJs(mb, enc))
            "writeopen" -> js(wv, writeOpenJs())
            "rangetest" -> {
                makeRangeFile(ctx)
                js(wv, rangeTestJs())
            }
            "securitytest" -> {
                makeSecurityFiles(ctx)
                js(wv, securityTestJs())
            }
            "videotest" -> js(wv, videoTestJs())
            "listcache" -> Log.i(TAG, "缓存清单：\n" + listing(File(ctx.cacheDir, "arkli")))
            else -> return false
        }
        return true
    }

    /** 往页面执行脚本 */
    private fun js(wv: WebView, body: String) = wv.evaluateJavascript("(function(){$JS_PRELUDE;$body})()", null)

    /** 生成一张 200x200 的 PNG 放进缓存夹具目录，返回文件名 */
    private fun makePng(ctx: Context): String {
        val dir = File(ctx.cacheDir, "arkli/$FIXTURE_DIR").apply { mkdirs() }
        val name = "arkli-dbg-${System.currentTimeMillis()}.png"
        val bmp = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
        Canvas(bmp).drawColor(Color.rgb(30, 144, 255))
        FileOutputStream(File(dir, name)).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        return name
    }

    /** 生成 Range 夹具：第 i 字节是 i 对 251 取余 */
    private fun makeRangeFile(ctx: Context) {
        val dir = File(ctx.cacheDir, "arkli/$FIXTURE_DIR").apply { mkdirs() }
        File(dir, RANGE_FILE).writeBytes(ByteArray(RANGE_SIZE) { (it % 251).toByte() })
    }

    /** 生成 /files/ 安全头夹具：html、svg 各一份，外加一张 png */
    private fun makeSecurityFiles(ctx: Context) {
        val dir = File(ctx.cacheDir, "arkli/$FIXTURE_DIR").apply { mkdirs() }
        File(dir, "evil.html").writeText("<html><script>document.title='pwned'</script>hi</html>")
        File(dir, "evil.svg").writeText("<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><rect width='20' height='20' fill='red'/></svg>")
        File(dir, "pic.png").writeBytes(File(dir, makePng(ctx)).readBytes())
    }

    /** 检查 /files/ 响应的 mime 与安全头，并确认 img 引用 png/svg 仍能加载 */
    private fun securityTestJs(): String = """
(async function(){
 var names=['evil.html','evil.svg','pic.png'];
 for(var i=0;i<names.length;i++){
  try{var r=await fetch('/files/cache/$FIXTURE_DIR/'+names[i]);
   __log('sectest',names[i],'status='+r.status,'ct='+r.headers.get('Content-Type'),'nosniff='+r.headers.get('X-Content-Type-Options'),'csp='+r.headers.get('Content-Security-Policy'));
  }catch(e){__log('sectest',names[i],'EXCEPTION',e&&e.message);}
 }
 var imgs=['pic.png','evil.svg'];
 for(var j=0;j<imgs.length;j++){
  await new Promise(function(res){var im=new Image();
   im.onload=function(){__log('sectest img',imgs[j],'loaded',im.naturalWidth+'x'+im.naturalHeight);res();};
   im.onerror=function(){__log('sectest img',imgs[j],'ERROR');res();};
   im.src='/files/cache/$FIXTURE_DIR/'+imgs[j]+'?t='+Date.now();});
 }
})();
"""

    /** 递归列出目录文件与大小 */
    private fun listing(root: File): String =
        root.walkTopDown().filter { it.isFile }.joinToString("\n") { "${it.path.removePrefix(root.path)} ${it.length()}" }

    /** 分块上传 [mb] MB 随机数据，校验 sha256 与幂等、缺口、关闭后再写等负例，并回读校验 */
    private fun writeTestJs(mb: Int, enc: String): String = """
(async function(){
 var total=$mb*1048576, data=new Uint8Array(total), x=123456789;
 for(var i=0;i<total;i++){x^=x<<13;x^=x>>>17;x^=x<<5;data[i]=x&255;}
 var sha=__hex(await crypto.subtle.digest('SHA-256',data));
 var mem0=performance.memory?performance.memory.usedJSHeapSize:0, t0=performance.now();
 var op=await __rpc('native.file.openWrite',{name:'w-$mb.bin',size:total,sha256:sha});
 if(!op.ok){__log('writetest openWrite FAIL',JSON.stringify(op));return;}
 var h=op.data.handle, CH=op.data.chunkBytes, seq=0, off=0, peak=0;
 while(off<total){var n=Math.min(CH,total-off), u=data.subarray(off,off+n);
  var s=__latin1(u); if('$enc'==='base64') s=btoa(s);
  var r=await __rpc('native.file.write',{handle:h,seq:seq,offset:off,data:s,encoding:'$enc'});
  if(!r.ok){__log('writetest write FAIL seq',seq,JSON.stringify(r));return;}
  if(seq===0){var r2=await __rpc('native.file.write',{handle:h,seq:0,offset:0,data:s,encoding:'$enc'});
   __log('writetest resend seq0 idempotent ok='+r2.ok+' written='+(r2.data&&r2.data.written));
   var g=await __rpc('native.file.write',{handle:h,seq:5,offset:off+n,data:'a',encoding:'latin1'});
   __log('writetest gap seq=5 ->',g.ok?'UNEXPECTED OK':g.error.code);}
  if(performance.memory)peak=Math.max(peak,performance.memory.usedJSHeapSize);
  off+=n; seq++;}
 var c=await __rpc('native.file.closeWrite',{handle:h});
 var dt=(performance.now()-t0)/1000;
 __log('writetest close ok='+c.ok,JSON.stringify(c.data||c.error));
 __log('writetest enc=$enc size='+total+' time='+dt.toFixed(2)+'s speed='+(total/1048576/dt).toFixed(1)+'MB/s jsHeapDeltaPeak='+((peak-mem0)/1048576).toFixed(1)+'MB');
 if(c.ok){__log('writetest sha match(server)='+(c.data.sha256===sha));
  var back=await (await fetch(c.data.url)).arrayBuffer();
  var sha2=__hex(await crypto.subtle.digest('SHA-256',back));
  __log('writetest readback via PathHandler len='+back.byteLength+' sha match='+(sha2===sha));
  var again=await __rpc('native.file.closeWrite',{handle:h});
  __log('writetest closeWrite again idempotent ok='+again.ok);
  var late=await __rpc('native.file.write',{handle:h,seq:seq,offset:total,data:'a'});
  __log('writetest write after close ->',late.ok?'UNEXPECTED OK':late.error.code);}
 var bad=await __rpc('native.file.write',{handle:'nope',seq:0,offset:0,data:'a'});
 __log('writetest unknown handle ->',bad.ok?'UNEXPECTED OK':bad.error.code);
 var wide=await __rpc('native.file.openWrite',{name:'x'}); var wr=await __rpc('native.file.write',{handle:wide.data.handle,seq:0,offset:0,data:'中'});
 __log('writetest non-latin1 char ->',wr.ok?'UNEXPECTED OK':wr.error.code);
 await __rpc('native.file.closeWrite',{handle:wide.data.handle,abort:true});
})();
"""

    /** 用真正的 video 元素加载缓存里的 test.mp4，拖到中间验证 Range 能让媒体栈正常寻址 */
    private fun videoTestJs(): String = """
(async function(){
 var v=document.createElement('video'); v.muted=true; v.preload='auto'; v.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px';
 document.body.appendChild(v);
 v.addEventListener('error',function(){__log('videotest ERROR code='+(v.error&&v.error.code)+' '+(v.error&&v.error.message));});
 v.src='/files/cache/$FIXTURE_DIR/test.mp4';
 await new Promise(function(r){v.addEventListener('loadedmetadata',r,{once:true});setTimeout(r,8000);});
 __log('videotest metadata readyState='+v.readyState+' duration='+v.duration+' size='+v.videoWidth+'x'+v.videoHeight);
 v.currentTime=v.duration/2;
 await new Promise(function(r){v.addEventListener('seeked',r,{once:true});setTimeout(r,8000);});
 __log('videotest seeked currentTime='+v.currentTime.toFixed(2)+' readyState='+v.readyState+' seekable='+(v.seekable.length?v.seekable.end(0):'none'));
 v.remove();
})();
"""

    /** 打开一个句柄、写两块但不关闭，用来验证渲染进程崩溃后被清理 */
    private fun writeOpenJs(): String = """
(async function(){
 var op=await __rpc('native.file.openWrite',{name:'orphan.bin'});
 var h=op.data.handle, u=new Uint8Array(1048576);
 for(var s=0;s<2;s++){await __rpc('native.file.write',{handle:h,seq:s,offset:s*1048576,data:__latin1(u)});}
 __log('writeopen opened handle',h,'2MB written, not closed');
})();
"""

    /** Range、整文件、416 与目录穿越用例，期望值写在日志里便于肉眼核对 */
    private fun rangeTestJs(): String = """
(async function(){
 var base='/files/cache/$FIXTURE_DIR/$RANGE_FILE';
 async function t(name,url,range,expect){
  try{
  var h=range?{Range:range}:{}; var r=await fetch(url,{headers:h}); var b=new Uint8Array(await r.arrayBuffer());
  var okBody=true; var cr=r.headers.get('Content-Range');
  if(r.status===206){var m=/bytes (\d+)-(\d+)/.exec(cr); for(var i=0;i<b.length;i++){if(b[i]!==((+m[1]+i)%251)){okBody=false;break;}}}
  __log('rangetest',name,'status='+r.status,'len='+b.length,'cr='+cr,'ar='+r.headers.get('Accept-Ranges'),'bodyOk='+okBody,'first='+Array.prototype.slice.call(b,0,4).join(','),'expect='+expect);
  }catch(e){__log('rangetest',name,'EXCEPTION',e&&e.message);}}
 await t('full',base,null,'200 len=$RANGE_SIZE');
 await t('mid',base,'bytes=10-19','206 len=10');
 await t('open-ended',base,'bytes=${RANGE_SIZE - 5}-','206 len=5');
 await t('suffix',base,'bytes=-7','206 len=7');
 await t('past-end',base,'bytes=${RANGE_SIZE * 2}-','416');
 await t('traversal-%2f','/files/cache/..%2f..%2fdatabases',null,'404');
 await t('traversal-%2f-2','/files/cache/out/..%2f..%2f..%2fshared_prefs',null,'404');
 await t('traversal-backslash','/files/cache/out/..%5c..%5cx',null,'404');
 await t('traversal-dots','/files/cache/%2e%2e/%2e%2e/x',null,'404 (浏览器先归一化)');
 await t('missing','/files/cache/out/nope.bin',null,'404');
 await t('packs-missing','/files/packs/nope.bin',null,'404');
 await t('unknown-prefix','/files/secret/x',null,'404');
})();
"""
}
