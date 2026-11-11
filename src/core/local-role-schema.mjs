const text=(maxLength,minLength=1)=>({type:'string',minLength,maxLength});
const integer={type:'integer',minimum:1};
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const requestId=text(160),expectedVersion=integer;
const persona=object(Object.fromEntries(['backgrounds','temper','trait','habit','dialogue'].map(name=>[name,text(100000,0)])));
const ids={type:'array',items:text(160),minItems:1,maxItems:15};
export const LOCAL_ROLE_CAPABILITIES=Object.freeze(['self.read','self.profile','self.avatar','memory.read','memory.write','bot.create','group.create','group.invite','peer.send']);
export const LOCAL_ROLE_TOOLS=Object.freeze([
 {name:'suna_self',description:'查看或修改自己的名称、人设和头像。修改必须使用最新角色版本和唯一 requestId。人设不会改变工具权限。',caps:['self.read','self.profile','self.avatar'],inputSchema:object({mode:{type:'string',enum:['get','update']},requestId,expectedVersion,name:text(40),persona,avatarRef:text(512)},['mode'])},
 {name:'suna_memory',description:'查询、添加、编辑或移除自己的工作记忆。编辑/移除要求记忆版本。来源由宿主记录。',caps:['memory.read','memory.write'],inputSchema:object({mode:{type:'string',enum:['list','add','update','remove']},requestId,id:text(160),expectedVersion,content:text(100000),limit:{type:'integer',minimum:1,maximum:50}},['mode'])},
 {name:'suna_contacts',description:'列出本地其他角色及可用本地群的公开名称和 ID，不读取他们的记忆或私聊。',caps:['group.create','group.invite','peer.send'],inputSchema:object({})},
 {name:'suna_create_bot',description:'创建一个本地 companion 角色。新角色具有相同的固有本地能力，不继承创建者的账号、凭据或记忆。',caps:['bot.create'],inputSchema:object({requestId,name:text(40),persona:text(100000,0)},['requestId','name'])},
 {name:'suna_create_group',description:'创建包含自己与其他角色的 SUNA 本地群，不创建外部平台群。',caps:['group.create'],inputSchema:object({requestId,title:text(80),participantIds:ids},['requestId','title','participantIds'])},
 {name:'suna_invite',description:'把其他角色加入自己已加入的有效本地群；使用最新群版本。',caps:['group.invite'],inputSchema:object({requestId,groupId:text(160),participantIds:ids,expectedVersion},['requestId','groupId','participantIds','expectedVersion'])},
 {name:'suna_peer_message',description:'与其他角色开启独立内核 A2A 会话。显式内容在当前对话的原位标记中显示，消息链有上限。queued 不等于回复完成。',caps:['peer.send'],inputSchema:object({requestId,targetId:text(160),content:text(12000)},['requestId','targetId','content'])}
]);
export const LOCAL_ROLE_DEFAULT_LIMITS=Object.freeze({createdBots:5,createdGroups:5,members:8,dailyMessages:16,maxHops:3,chainMessages:8});

// Discovery has no grant capability: only the current Host-bound role may read it.
export const LOCAL_ROLE_DISCOVERY_TOOL=Object.freeze({
 name:'suna_role_capabilities',
 description:'查询自己在当前本地对话可用的角色能力、工具和通信限制，及实际通信状态。所有角色固有具备这些本地能力，无需权限设置；本工具只读。',
 inputSchema:{type:'object',properties:{},additionalProperties:false},
});
