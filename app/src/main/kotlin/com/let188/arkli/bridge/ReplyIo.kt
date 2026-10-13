package com.let188.arkli.bridge

/**
 * 回传通道抽象：和具体 WebView 通道解耦，测试里可以塞假实现。
 */
fun interface ReplyIo {
    /**
     * 回传一条 JSON 文本给页面。页面已销毁时允许抛异常，调用方会吞掉。
     *
     * @param json 响应或事件的 JSON
     */
    fun send(json: String)
}
