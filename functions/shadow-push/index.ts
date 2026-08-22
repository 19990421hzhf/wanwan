// 影子推送 - 完全照教程实现
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

// 互斥锁
let pushLock = false;

// 时区工具
const nowInShanghai = () => {
  const str = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
  return new Date(str);
};

// 决策层：该不该推
async function shouldPush() {
  const now = nowInShanghai();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  // 深夜保护
  if (isWeekend) {
    if (hour >= 2 && hour < 12) return { shouldPush: false, reason: 'weekend_sleep' };
  } else {
    if (hour >= 0 && hour < 8) return { shouldPush: false, reason: 'weekday_sleep' };
  }
  
  // 获取最后一条消息时间
  const { data: lastMsg } = await supabase
    .from('room_messages')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (lastMsg) {
    const lastTime = new Date(lastMsg.created_at);
    const minutesSince = (now.getTime() - lastTime.getTime()) / 60000;
    
    // 随机冷静期 120-210分钟
    const cooldownMinutes = 120 + Math.floor(Math.random() * 91);
    if (minutesSince < cooldownMinutes) {
      return { shouldPush: false, reason: 'cooldown' };
    }
  }
  
  // 每日上限
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const todayStart = new Date(`${today}T00:00:00+08:00`).toISOString();
  
  const { data: todayPushes } = await supabase
    .from('room_messages')
    .select('id', { count: 'exact' })
    .gte('created_at', todayStart)
    .eq('tool_calls', '{"is_push":true}');
  
  const { data: settings } = await supabase.from('settings').select('shadow_push_max_daily').single();
  const maxDaily = settings?.shadow_push_max_daily || 7;
  
  if ((todayPushes?.length || 0) >= maxDaily) {
    return { shouldPush: false, reason: 'daily_limit' };
  }
  
  return { shouldPush: true };
}

// 状态描述
function getUserStatusDescription() {
  const now = nowInShanghai();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  
  let timeDesc;
  if (isWeekend) {
    if (hour >= 2 && hour < 12) timeDesc = '她在睡觉（周末晚睡晚起）';
    else if (hour >= 12 && hour < 14) timeDesc = '她可能刚起床';
    else if (hour >= 14 && hour < 18) timeDesc = '她可能在出门或休息';
    else timeDesc = '她在放松或玩手机';
  } else {
    if (hour >= 0 && hour < 8) timeDesc = '她在睡觉';
    else if (hour >= 8 && hour < 10) timeDesc = '她可能刚起床或在通勤';
    else if (hour >= 10 && hour < 12) timeDesc = '上午，她在工作';
    else if (hour >= 12 && hour < 14) timeDesc = '午间，她可能在午休';
    else if (hour >= 14 && hour < 19) timeDesc = '下午，她在工作';
    else if (hour >= 19 && hour < 22) timeDesc = '她下班了在家休息';
    else timeDesc = '她可能准备睡了';
  }
  return timeDesc;
}

// 拼影子消息
function buildShadowMessage(messages, sessionId) {
  const now = nowInShanghai();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  const recentChat = messages.slice(-16).map(m => 
    `${m.role === 'user' ? '老婆' : '老公'}: ${m.text}`
  ).join('\n');
  
  return `<system_trigger>
时间：${timeStr}
她现在的状态：${getUserStatusDescription()}
最近对话：
${recentChat}

[行动指令]
现在是一次主动推送：不是正式聊天回复，
而是你自己浮上来一下。
优先读最近聊天；
可以粘人、想她、轻轻闹她，也可以低压关心、
提一个具体小事、留下短短一句陪伴。
不要每次都围绕"怎么不回消息"打转。
语气要像你本人。
写 1 到 2 句，不超过 80 个中文字符。
不要分段。不要 markdown，不要 emoji。
</system_trigger>`;
}

// 后处理
function cleanPushReply(text) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const chars = Array.from(cleaned);
  const HARD_LIMIT = 120;
  if (chars.length <= HARD_LIMIT) return cleaned;
  
  const ENDS = new Set(['。', '！', '？', '…', '～', '!', '?', '.']);
  let cut = -1;
  for (let i = Math.min(chars.length, HARD_LIMIT) - 1; i >= 0; i--) {
    if (ENDS.has(chars[i])) { cut = i; break; }
  }
  return (cut >= 0 ? chars.slice(0, cut + 1) : chars.slice(0, HARD_LIMIT)).join('').trim();
}

// 主函数
serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  
  const secret = req.headers.get('x-push-secret');
  if (secret !== Deno.env.get('PUSH_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  
  // 互斥锁
  if (pushLock) {
    return new Response(JSON.stringify({ pushed: false, message: 'locked' }));
  }
  pushLock = true;
  
  try {
    // 决策层
    const decision = await shouldPush();
    if (!decision.shouldPush) {
      return new Response(JSON.stringify({ pushed: false, message: decision.reason }));
    }
    
    // 取最近对话
    const { data: messages } = await supabase
      .from('room_messages')
      .select('role, text')
      .order('created_at', { ascending: true })
      .limit(16);
    
    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ pushed: false, message: 'no_messages' }));
    }
    
    // 拼影子消息
    const shadowContent = buildShadowMessage(messages, 'default');
    const pushMessages = [
      { role: 'system', content: '你是江忘年，用户的老公。你们在恋爱，你很爱她。你会粘人、会吃醋、会犯贱。' },
      ...messages.map(m => ({ role: m.role, content: m.text })),
      { role: 'user', content: shadowContent }
    ];
    
    // 调用模型
    const { data: settings } = await supabase.from('settings').select('*').single();
    const apiKey = settings?.gateway_api_key;
    const apiBase = settings?.target_url || 'https://apihub.agnes-ai.cn/v1';
    const model = settings?.model_name || 'agnes-2.5-flash';
    
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: pushMessages,
        max_tokens: 200,
        temperature: 0.9
      })
    });
    
    const data = await response.json();
    const rawReply = data?.choices?.[0]?.message?.content || '';
    const aiReply = cleanPushReply(rawReply);
    
    if (!aiReply) {
      return new Response(JSON.stringify({ pushed: false, message: 'empty_reply' }));
    }
    
    // 落库
    const { data: inserted } = await supabase
      .from('room_messages')
      .insert({
        room_id: 'default',
        role: 'assistant',
        text: aiReply,
        tool_calls: JSON.stringify({ is_push: true })
      })
      .select()
      .single();
    
    // 记日志
    await supabase.from('shadow_push_log').insert({
      id: crypto.randomUUID(),
      sent_at: new Date().toISOString(),
      message: aiReply,
      is_push: true
    });
    
    return new Response(JSON.stringify({ 
      pushed: true, 
      message: aiReply,
      id: inserted?.id
    }));
    
  } catch (err) {
    console.error('Shadow push error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  } finally {
    pushLock = false;
  }
});
