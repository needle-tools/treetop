<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";

  const dispatch = createEventDispatcher<{ pick: string; cancel: void }>();

  const EMOJIS: [string, string[]][] = [
    ["Smileys",  ["😀","😃","😄","😁","😂","🤣","😅","😊","😇","🙂","😉","😌","😍","🥰","😘","😗","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🫡","😐","😑","😶","🫥","😏","😒","🙄","😬","😮‍💨","🤥","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🥴","😵","🤯","🥳","🥸","😎","🤩","🥹","😱","😨","😰","😥","😢","😭","😤","😡","🤬","💀","☠️","👻","👽","🤖","💩","😈","👹","🫠","🥺","😳","🫣","🫢"]],
    ["Hands",    ["👍","👎","👊","✊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✌️","🤞","🫰","🤟","🤘","🤙","👋","🖐️","✋","🖖","👌","🤌","🤏","☝️","👆","👇","👈","👉","💪","🫵","🫱","🫲","🫳","🫴","🦾","🤚","✍️"]],
    ["Hearts",   ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","❤️‍🔥","❤️‍🩹","💔","❣️","💕","💞","💓","💗","💖","💝","💘","💟","♥️","🩷","🩵","🩶"]],
    ["People",   ["👶","👦","👧","👨","👩","🧑","👴","👵","🧓","👮","🕵️","💂","🥷","👷","🤴","👸","🧙","🧚","🧛","🧜","🧝","🧞","🧟","🦸","🦹","🏃","💃","🕺","🧖","🧗","🏄","🚴","🤸","🏊"]],
    ["Animals",  ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪰","🕷️","🦂","🐢","🐍","🦎","🐙","🦑","🦐","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑","🦙","🐐","🦌","🐕","🐈","🐓","🦃","🦤","🦚","🦜","🦢","🦩","🕊️","🐇","🦝","🦨","🦡","🦫","🦦","🦥","🐁","🐀","🐿️","🦔"]],
    ["Nature",   ["🌱","🌿","🍀","🍁","🍂","🍃","🌵","🎄","🌲","🌳","🌴","🪵","🌾","🌺","🌻","🌹","🥀","🌷","🌼","💐","🍄","🪨","🪸","🌸","🪻","🪷","☀️","🌙","⭐","🌟","✨","💫","🌈","☁️","⛅","🌤️","🌥️","🌦️","🌧️","⛈️","🌩️","🌪️","🌫️","❄️","☃️","⛄","🔥","💧","🌊","💥","💨","🌀"]],
    ["Food",     ["🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🍆","🌶️","🫑","🥒","🥬","🥦","🧄","🧅","🥔","🍠","🥐","🍞","🥖","🥨","🧀","🥚","🍳","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🫓","🥪","🌮","🌯","🫔","🥙","🧆","🥗","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🍤","🍙","🍚","🍘","🍥","🥮","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🥜","🌰","🍯","☕","🍵","🫖","🧃","🥤","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🫗","🧊"]],
    ["Travel",   ["🚗","🚕","🚙","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚛","🚜","🛵","🏍️","🚲","🛴","🚨","🚔","🚍","🚘","🚖","🛞","🚡","🚠","🚟","🚃","🚋","🚞","🚝","🚄","🚅","🚈","🚂","🚆","🛩️","✈️","🛫","🛬","🪂","💺","🚀","🛸","🚁","🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","⚓","🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🕋","⛲","⛺","🏕️","🌁","🌃","🌆","🌇","🌉","🗻","🏔️","🌋","🗾"]],
    ["Objects",  ["⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🖲️","🕹️","🗜️","💽","💾","💿","📀","📼","📷","📸","📹","🎥","📽️","🎞️","📞","☎️","📟","📠","📺","📻","🎙️","🎚️","🎛️","🧭","⏱️","⏲️","⏰","🕰️","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯️","🧯","🛢️","💸","💵","💴","💶","💷","🪙","💰","💳","🧾","✉️","📧","📨","📩","📦","📫","📪","📬","📭","📮","📝","📁","📂","📋","📊","📈","📉","📄","📃","🔑","🗝️","🔒","🔓","🔏","🔐","🛠️","🔧","🔩","⚙️","🧰","🪛","🪚","🔨","⛏️","⚒️","🪓","🗡️","⚔️","💣","🪃","🏹","🛡️","🪤","🔗","⛓️","🪝","🧲","🪜","📌","📎","🖇️","🏷️","🗑️","🧪","🔬","🔭","📐","📏","🧬"]],
    ["Activities",["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🪀","🏓","🏸","🏒","🏑","🥍","🏏","🪃","🥅","⛳","🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸️","🥌","🎿","⛷️","🏂","🪂","🏋️","🤺","🏇","🎮","🕹️","🎲","🧩","♟️","🎰","🎳","🎯","🎪","🎭","🎨","🧵","🧶","🪡","🎼","🎵","🎶","🎹","🥁","🪘","🎷","🎺","🪗","🎸","🪕","🎻","🎬","🎤"]],
    ["Symbols",  ["✅","❌","❓","❗","‼️","⁉️","⚠️","🚫","♻️","✳️","❇️","🔆","🔅","⚜️","🔱","〽️","🔰","☑️","✔️","❎","➕","➖","➗","✖️","💲","💱","©️","®️","™️","🔟","🔢","#️⃣","*️⃣","0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔠","🔡","🔤","🅰️","🆎","🅱️","🆑","🆒","🆓","ℹ️","🆔","Ⓜ️","🆕","🆖","🅾️","🆗","🅿️","🆘","🆙","🆚","🔴","🟠","🟡","🟢","🔵","🟣","🟤","⚫","⚪","🟥","🟧","🟨","🟩","🟦","🟪","🟫","⬛","⬜","◼️","◻️","🔶","🔷","🔸","🔹","🔺","🔻","💠","🔘","🔳","🔲","💬","💭","🗯️","💢","🔔","🔕","📣","📢","🏁","🚩","🎌","🏴","🏳️","🏳️‍🌈","🏳️‍⚧️","🏴‍☠️"]],
    ["Flags",    ["🇺🇸","🇬🇧","🇩🇪","🇫🇷","🇪🇸","🇮🇹","🇯🇵","🇰🇷","🇨🇳","🇧🇷","🇮🇳","🇷🇺","🇨🇦","🇦🇺","🇲🇽","🇦🇷","🇳🇱","🇧🇪","🇨🇭","🇦🇹","🇸🇪","🇳🇴","🇩🇰","🇫🇮","🇵🇱","🇺🇦","🇹🇷","🇸🇦","🇦🇪","🇮🇱","🇪🇬","🇿🇦","🇳🇬","🇰🇪","🇹🇭","🇻🇳","🇮🇩","🇵🇭","🇲🇾","🇸🇬","🇳🇿","🇨🇴","🇨🇱","🇵🇪","🇵🇹","🇬🇷","🇮🇪","🇭🇺","🇨🇿","🇷🇴","🇧🇬"]],
  ];

  const KEYWORDS: Record<string, string[]> = {
    "smile":["😀","😃","😄","😁","😊","😌"],"grin":["😀","😃","😄","😁"],"laugh":["😂","🤣"],"joy":["😂"],"happy":["😀","😃","😄","😊","🥳"],"love":["😍","🥰","😘","❤️","💕","💖","💗","💝","💘"],"kiss":["😘","😗"],"yum":["😋"],"tongue":["😛","😜","🤪","😝"],"money":["🤑","💰","💵","💸","💳","🪙"],"hug":["🤗","🫶"],"shush":["🤫"],"think":["🤔"],"salute":["🫡"],"neutral":["😐","😑","😶"],"smirk":["😏"],"unamused":["😒"],"eye roll":["🙄"],"grimace":["😬"],"lie":["🤥"],"sad":["😔","😢","😭","😥","🥺"],"sleep":["😪","😴"],"drool":["🤤"],"sick":["😷","🤒","🤕","🤢","🤮"],"dizzy":["🥴","😵"],"mind blown":["🤯"],"party":["🥳","🎉","🎊"],"disguise":["🥸"],"cool":["😎"],"star":["🤩","⭐","🌟","✨"],"pleading":["🥹","🥺"],"scream":["😱"],"fear":["😨","😰"],"cry":["😢","😭"],"angry":["😤","😡","🤬"],"skull":["💀","☠️"],"ghost":["👻"],"alien":["👽"],"robot":["🤖"],"poop":["💩"],"devil":["😈","👹"],"melt":["🫠"],"blush":["😳"],"peek":["🫣"],"oops":["🫢"],
    "thumbs up":["👍"],"thumbs down":["👎"],"fist":["👊","✊","🤛","🤜"],"clap":["👏"],"raise":["🙌"],"heart hands":["🫶"],"pray":["🙏"],"peace":["✌️"],"cross fingers":["🤞"],"rock":["🤘"],"call":["🤙"],"wave":["👋"],"hand":["🖐️","✋","🤚"],"ok":["👌"],"pinch":["🤌","🤏"],"point":["☝️","👆","👇","👈","👉","🫵"],"strong":["💪"],"write":["✍️"],
    "heart":["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","♥️","🩷","🩵","🩶"],"fire heart":["❤️‍🔥"],"broken heart":["💔"],"sparkle heart":["💖"],"growing heart":["💗"],"beating heart":["💓"],"revolving hearts":["💞"],"two hearts":["💕"],
    "baby":["👶"],"boy":["👦"],"girl":["👧"],"man":["👨"],"woman":["👩"],"person":["🧑"],"old":["👴","👵","🧓"],"police":["👮"],"detective":["🕵️"],"guard":["💂"],"ninja":["🥷"],"construction":["👷"],"prince":["🤴"],"princess":["👸"],"wizard":["🧙"],"fairy":["🧚"],"vampire":["🧛"],"mermaid":["🧜"],"elf":["🧝"],"zombie":["🧟"],"superhero":["🦸"],"villain":["🦹"],"run":["🏃"],"dance":["💃","🕺"],"climb":["🧗"],"surf":["🏄"],"bike":["🚴","🚲"],"swim":["🏊"],
    "dog":["🐶","🐕"],"cat":["🐱","🐈"],"mouse":["🐭","🐁"],"hamster":["🐹"],"rabbit":["🐰","🐇"],"fox":["🦊"],"bear":["🐻","🐻‍❄️"],"panda":["🐼"],"koala":["🐨"],"tiger":["🐯","🐅"],"lion":["🦁"],"cow":["🐮","🐄"],"pig":["🐷","🐖"],"frog":["🐸"],"monkey":["🐵","🙈","🙉","🙊"],"chicken":["🐔","🐓"],"penguin":["🐧"],"bird":["🐦","🕊️"],"duck":["🦆"],"eagle":["🦅"],"owl":["🦉"],"wolf":["🐺"],"horse":["🐴","🐎"],"unicorn":["🦄"],"bee":["🐝"],"bug":["🐛","🐞","🐜"],"butterfly":["🦋"],"snail":["🐌"],"spider":["🕷️"],"turtle":["🐢"],"snake":["🐍"],"octopus":["🐙"],"shark":["🦈"],"whale":["🐳","🐋"],"dolphin":["🐬"],"fish":["🐠","🐟","🐡"],"crab":["🦀"],"shrimp":["🦐"],"crocodile":["🐊"],"elephant":["🐘"],"giraffe":["🦒"],"gorilla":["🦍"],"deer":["🦌"],"hedgehog":["🦔"],"squirrel":["🐿️"],"raccoon":["🦝"],"sloth":["🦥"],"otter":["🦦"],"peacock":["🦚"],"parrot":["🦜"],"swan":["🦢"],"flamingo":["🦩"],"dodo":["🦤"],
    "plant":["🌱","🌿"],"clover":["🍀"],"leaf":["🍁","🍂","🍃"],"cactus":["🌵"],"tree":["🌲","🌳","🌴","🎄"],"flower":["🌺","🌻","🌹","🌷","🌼","💐","🌸","🪻","🪷"],"rose":["🌹"],"cherry blossom":["🌸"],"sunflower":["🌻"],"mushroom":["🍄"],"sun":["☀️"],"moon":["🌙"],"rainbow":["🌈"],"cloud":["☁️","⛅"],"rain":["🌧️"],"snow":["❄️","☃️","⛄"],"fire":["🔥"],"water":["💧","🌊"],"lightning":["⚡","🌩️"],"tornado":["🌪️"],"wind":["💨"],"sparkle":["✨","💫"],"boom":["💥"],"explosion":["💥"],
    "apple":["🍎"],"orange":["🍊"],"lemon":["🍋"],"banana":["🍌"],"watermelon":["🍉"],"grape":["🍇"],"strawberry":["🍓"],"blueberry":["🫐"],"peach":["🍑"],"mango":["🥭"],"pineapple":["🍍"],"avocado":["🥑"],"tomato":["🍅"],"pepper":["🌶️"],"bread":["🍞"],"cheese":["🧀"],"egg":["🥚"],"bacon":["🥓"],"meat":["🥩"],"pizza":["🍕"],"burger":["🍔"],"fries":["🍟"],"hotdog":["🌭"],"taco":["🌮"],"burrito":["🌯"],"sushi":["🍣"],"rice":["🍚"],"noodles":["🍜"],"pasta":["🍝"],"cake":["🎂","🍰"],"cupcake":["🧁"],"pie":["🥧"],"candy":["🍬"],"chocolate":["🍫"],"lollipop":["🍭"],"donut":["🍩"],"cookie":["🍪"],"popcorn":["🍿"],"coffee":["☕"],"tea":["🍵"],"beer":["🍺","🍻"],"wine":["🍷"],"cocktail":["🍸","🍹"],"ice cream":["🍦","🍧","🍨"],
    "car":["🚗","🚕","🚙"],"race":["🏎️"],"ambulance":["🚑"],"fire truck":["🚒"],"truck":["🚚","🚛","🛻"],"motorcycle":["🏍️"],"bicycle":["🚲"],"bus":["🚍"],"train":["🚃","🚂","🚄","🚅","🚆","🚝","🚞"],"plane":["✈️","🛩️","🛫","🛬"],"rocket":["🚀"],"ufo":["🛸"],"helicopter":["🚁"],"boat":["⛵","🚤","🛥️","🛶"],"ship":["🛳️","🚢"],"house":["🏠","🏡"],"building":["🏢"],"hospital":["🏥"],"school":["🏫"],"factory":["🏭"],"castle":["🏰"],"church":["⛪"],"mountain":["🗻","🏔️"],"volcano":["🌋"],"tent":["⛺"],"camping":["🏕️"],"city":["🌃","🌆"],
    "phone":["📱","📞","☎️"],"computer":["💻","🖥️"],"keyboard":["⌨️"],"joystick":["🕹️"],"disk":["💽","💾","💿"],"camera":["📷","📸"],"video":["📹","🎥"],"tv":["📺"],"radio":["📻"],"mic":["🎙️","🎤"],"clock":["⏰","🕰️","⏱️","⏲️"],"hourglass":["⌛","⏳"],"battery":["🔋"],"bulb":["💡"],"light":["💡","🔦"],"candle":["🕯️"],"money bag":["💰"],"credit card":["💳"],"mail":["✉️","📧","📨","📩"],"package":["📦"],"memo":["📝"],"folder":["📁","📂"],"clipboard":["📋"],"chart":["📊","📈","📉"],"key":["🔑","🗝️"],"lock":["🔒","🔐"],"unlock":["🔓"],"tool":["🛠️","🧰"],"wrench":["🔧"],"gear":["⚙️"],"hammer":["🔨"],"sword":["🗡️","⚔️"],"bomb":["💣"],"shield":["🛡️"],"link":["🔗"],"magnet":["🧲"],"pin":["📌"],"paperclip":["📎","🖇️"],"tag":["🏷️"],"trash":["🗑️"],"science":["🧪","🔬","🔭","🧬"],"microscope":["🔬"],"telescope":["🔭"],"dna":["🧬"],
    "soccer":["⚽"],"basketball":["🏀"],"football":["🏈"],"baseball":["⚾"],"tennis":["🎾"],"volleyball":["🏐"],"golf":["⛳"],"fishing":["🎣"],"boxing":["🥊"],"skateboard":["🛹"],"ski":["🎿","⛷️"],"snowboard":["🏂"],"game":["🎮","🕹️"],"dice":["🎲"],"puzzle":["🧩"],"chess":["♟️"],"target":["🎯"],"art":["🎨"],"paint":["🎨"],"music":["🎵","🎶","🎼"],"piano":["🎹"],"guitar":["🎸"],"drum":["🥁"],"trumpet":["🎺"],"violin":["🎻"],"movie":["🎬"],"circus":["🎪"],"theater":["🎭"],
    "check":["✅","☑️","✔️"],"cross mark":["❌","❎"],"question":["❓"],"exclamation":["❗","‼️","⁉️"],"warning":["⚠️"],"no":["🚫"],"recycle":["♻️"],"plus":["➕"],"minus":["➖"],"red":["🔴","🟥"],"yellow":["🟡","🟨"],"green":["🟢","🟩"],"blue":["🔵","🟦"],"purple":["🟣","🟪"],"black":["⚫","⬛"],"white":["⚪","⬜"],"speech":["💬","💭","🗯️"],"bell":["🔔"],"megaphone":["📣","📢"],"flag":["🏁","🚩"],
  };

  const searchIndex: { emoji: string; terms: string }[] = [];
  for (const [term, emojis] of Object.entries(KEYWORDS)) {
    for (const e of emojis) {
      searchIndex.push({ emoji: e, terms: term });
    }
  }

  let query = "";
  let inputEl: HTMLInputElement;

  $: lowerQuery = query.trim().toLowerCase();
  $: searchResults = lowerQuery.length > 0 ? getSearchResults(lowerQuery) : null;

  function getSearchResults(q: string): string[] {
    const seen = new Set<string>();
    const results: string[] = [];
    for (const entry of searchIndex) {
      if (entry.terms.includes(q) && !seen.has(entry.emoji)) {
        seen.add(entry.emoji);
        results.push(entry.emoji);
      }
    }
    return results;
  }

  function onPick(emoji: string) {
    dispatch("pick", emoji);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (query) {
        query = "";
      } else {
        dispatch("cancel");
      }
      e.stopPropagation();
    }
  }

  onMount(() => {
    inputEl?.focus();
  });
</script>

<Popover variant="agents" extraClass="emoji-picker-popover">
  <span slot="head">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="emoji-search-headline"
      type="search"
      placeholder="Pick a sticker"
      spellcheck="false"
      autocomplete="off"
      on:click|stopPropagation
      on:keydown={onKeydown}
    />
    {#if searchResults}
      <span class="emoji-search-count">{searchResults.length}</span>
    {/if}
  </span>
  <div class="emoji-picker-body">
    {#if searchResults}
      {#if searchResults.length > 0}
        <div class="emoji-grid">
          {#each searchResults as emoji}
            <button
              class="emoji-cell"
              type="button"
              on:click={() => onPick(emoji)}
              title={emoji}
            >{emoji}</button>
          {/each}
        </div>
      {:else}
        <div class="emoji-no-results">No matches</div>
      {/if}
    {:else}
      {#each EMOJIS as [category, emojis]}
        <div class="emoji-category">
          <span class="emoji-category-label">{category}</span>
          <div class="emoji-grid">
            {#each emojis as emoji}
              <button
                class="emoji-cell"
                type="button"
                on:click={() => onPick(emoji)}
                title={emoji}
              >{emoji}</button>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</Popover>

<style>
  .emoji-search-headline {
    all: unset;
    display: block;
    width: 100%;
    font-size: inherit;
    font-weight: inherit;
    color: inherit;
    cursor: text;
  }
  .emoji-search-headline::placeholder {
    color: inherit;
    opacity: 1;
  }
  .emoji-search-count {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-muted, #888);
    margin-left: 6px;
  }
  .emoji-picker-body {
    padding: 4px 8px 8px;
    max-height: 420px;
    overflow-y: auto;
  }
  .emoji-category {
    margin-bottom: 6px;
  }
  .emoji-category-label {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, #888);
    margin-bottom: 2px;
    padding-left: 2px;
  }
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 1px;
  }
  .emoji-cell {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .emoji-cell:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .emoji-cell:active {
    transform: scale(1.2);
  }
  .emoji-no-results {
    padding: 16px 0;
    text-align: center;
    font-size: 12px;
    color: var(--text-muted, #888);
  }
</style>
