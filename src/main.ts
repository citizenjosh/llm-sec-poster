import { Devvit } from '@devvit/public-api';

const SUBREDDIT_NAME = 'llmsecurity';
const OPENAI_MODEL = 'gpt-3.5-turbo';
// Use Reddit's RSS - always allowed
const RSS_URL = 'https://www.reddit.com/r/netsec+cybersecurity+ArtificialIntelligence/.rss?limit=25';

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

// Settings UI
Devvit.addSettings([
  {
    type: 'string',
    name: 'openai_key',
    label: 'OpenAI API Key',
    isSecret: true,
    scope: 'app',
  }
]);

// --- SHARED LOGIC ---
async function getGptSummary(text: string, context: any) {
  try {
    const apiKey = await context.settings.get('openai_key');
    if (!apiKey) return 'Summary unavailable (API Key missing).';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ 
            role: "user", 
            content: `Analyze if this is SPECIFICALLY about LLM security, prompt injection, AI jailbreaking, or AI model security. Must be directly related to large language models or AI systems. If yes, summarize in 2-3 bullet points. If not directly LLM/AI security related, respond ONLY with "NOT_RELEVANT". Text: ${text}`
        }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'AI Summary failed.';
  } catch (e) {
    console.error('OpenAI Error:', e);
    return 'AI Summary error.';
  }
}

async function fetchAndPostNews(context: any) {
    console.log('Fetching security news from Reddit...');
    
    try {
      const response = await fetch(RSS_URL);
      const xmlText = await response.text();
      
      console.log(`Fetched ${xmlText.length} characters of RSS data`);
      
      const rawItems = xmlText.split('<entry>');
      console.log(`Found ${rawItems.length - 1} entries in RSS feed`);
      
      const newsItems = [];

      for (let i = 1; i < rawItems.length; i++) {
        const item = rawItems[i];
        
        // Reddit Atom feed uses different patterns
        const titleMatch = item.match(/<title[^>]*>(.*?)<\/title>/s);
        const linkMatch = item.match(/<link[^>]*href=["']([^"']+)["']/);
        const idMatch = item.match(/<id[^>]*>(.*?)<\/id>/s);
        const contentMatch = item.match(/<content[^>]*>([\s\S]*?)<\/content>/);
        
        console.log(`Entry ${i}: title=${!!titleMatch}, link=${!!linkMatch}, id=${!!idMatch}`);

        if (titleMatch && linkMatch && idMatch) {
          let snippet = contentMatch ? contentMatch[1] : '';
          snippet = snippet.replace(/<[^>]*>?/gm, ''); 
          snippet = snippet.replace(/&nbsp;/g, ' ');
          snippet = snippet.replace(/&lt;/g, '<');
          snippet = snippet.replace(/&gt;/g, '>');
          snippet = snippet.replace(/&amp;/g, '&');
          snippet = snippet.replace(/&quot;/g, '"');
          snippet = snippet.replace(/&#39;/g, "'");
          snippet = snippet.substring(0, 500);

          const title = titleMatch[1].replace(/&nbsp;/g, ' ')
                                     .replace(/&lt;/g, '<')
                                     .replace(/&gt;/g, '>')
                                     .replace(/&amp;/g, '&')
                                     .replace(/&quot;/g, '"')
                                     .replace(/&#39;/g, "'")
                                     .trim();

          newsItems.push({
            title: title,
            url: linkMatch[1],
            id: idMatch[1],
            snippet: snippet
          });
          
          console.log(`Successfully parsed: ${title.substring(0, 50)}...`);
        } else {
          console.log(`Failed to parse entry ${i}`);
        }
      }

      console.log(`Parsed ${newsItems.length} valid news items`);

      let postsCreated = 0;
      const MAX_POSTS_PER_RUN = 1; // Limit to 1 post per run
      
      // Reverse loop to post oldest first
      for (let i = newsItems.length - 1; i >= 0; i--) {
        if (postsCreated >= MAX_POSTS_PER_RUN) {
          console.log(`Reached limit of ${MAX_POSTS_PER_RUN} post(s) per run`);
          break;
        }
        
        const article = newsItems[i];
        const hasPosted = await context.redis.get(`posted_news:${article.id}`);
        
        if (!hasPosted) {
          console.log(`Found unposted article: ${article.title}`);
          console.log(`Processing: ${article.title}`);
          
          const summary = await getGptSummary(`${article.title}\n${article.snippet}`, context);
          
          if (summary.includes('NOT_RELEVANT')) {
            console.log('Article not relevant to LLM security, skipping...');
            const now = new Date();
            const expirationDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
            await context.redis.set(`posted_news:${article.id}`, 'true', { expiration: expirationDate });
            continue; // Skip this article but keep looking for more
          }

          const postBody = `[Link to Original Post](${article.url})\n\n**AI Summary:**\n${summary}\n\n---\n*Disclaimer: This post was automated by an LLM Security Bot. Content sourced from Reddit security communities.*`;

          await context.reddit.submitPost({
            subredditName: SUBREDDIT_NAME,
            title: article.title,
            text: postBody, 
          });

          const now = new Date();
          const expirationDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
          await context.redis.set(`posted_news:${article.id}`, 'true', { expiration: expirationDate });
          
          console.log(`Successfully posted: ${article.title}`);
          postsCreated++;
        }
      }

      if (postsCreated === 0) {
        console.log('No new articles found or all already posted.');
      } else {
        console.log(`Posted ${postsCreated} article(s) this run.`);
      }

    } catch (e) {
      console.error('Error fetching news:', e);
    }
}
// --- JOBS & MENUS ---

// 1. The Scheduled Job (Runs automatically)
Devvit.addSchedulerJob({
  name: 'post_security_news',
  onRun: async (event, context) => {
    await fetchAndPostNews(context);
  },
});

// 2. Menu: Start the Schedule
Devvit.addMenuItem({
  label: 'Start LLM Security Bot',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    await context.scheduler.runJob({
      name: 'post_security_news',
      cron: '0 */3 * * *',
    });
    context.ui.showToast('Security Bot Started! (Runs every 3 hours)');
  },
});

// 3. Menu: DEBUG Run Now (Click this to test immediately)
Devvit.addMenuItem({
  label: 'DEBUG: Run Fetch Now',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Fetching news now...');
    await fetchAndPostNews(context);
    context.ui.showToast('Fetch complete. Check logs.');
  },
});

export default Devvit;
