import MarkdownIt from 'markdown-it';

// Message images use the explicit, validated attachment block path instead.
const markdown = new MarkdownIt({html:false,breaks:true,linkify:false,typographer:false});
markdown.disable('image');
markdown.validateLink = value => {
  try {
    const url = new URL(value);
    return ['https:','http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};
markdown.renderer.rules.link_open = (tokens,index,options,_env,renderer) => {
  tokens[index].attrSet('target','_blank');
  tokens[index].attrSet('rel','noopener noreferrer');
  return renderer.renderToken(tokens,index,options);
};

export function renderMessageText(value) {
  return markdown.render(String(value ?? ''));
}
