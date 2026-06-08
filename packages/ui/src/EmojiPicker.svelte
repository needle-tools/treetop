<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";
  import { APP_ICONS, APP_ICON_TOKEN_PREFIX, appIconUrl } from "./app-icons";
  import {
    STICKER_PACKS,
    STICKER_TOKEN_PREFIX,
    stickerFromToken,
    stickerPreviewStyle,
    type StickerPack,
  } from "./sticker-packs";

  const dispatch = createEventDispatcher<{ pick: string; cancel: void }>();

  const EMOJIS: [string, string[]][] = [
    [
      "Smileys",
      [
        "😀",
        "😃",
        "😄",
        "😁",
        "😂",
        "🤣",
        "😅",
        "😊",
        "😇",
        "🙂",
        "😉",
        "😌",
        "😍",
        "🥰",
        "😘",
        "😗",
        "😋",
        "😛",
        "😜",
        "🤪",
        "😝",
        "🤑",
        "🤗",
        "🤭",
        "🤫",
        "🤔",
        "🫡",
        "😐",
        "😑",
        "😶",
        "🫥",
        "😏",
        "😒",
        "🙄",
        "😬",
        "😮‍💨",
        "🤥",
        "😔",
        "😪",
        "🤤",
        "😴",
        "😷",
        "🤒",
        "🤕",
        "🤢",
        "🤮",
        "🥴",
        "😵",
        "🤯",
        "🥳",
        "🥸",
        "😎",
        "🤩",
        "🥹",
        "😱",
        "😨",
        "😰",
        "😥",
        "😢",
        "😭",
        "😤",
        "😡",
        "🤬",
        "💀",
        "☠️",
        "👻",
        "👽",
        "🤖",
        "💩",
        "😈",
        "👹",
        "🫠",
        "🥺",
        "😳",
        "🫣",
        "🫢",
        "👀",
        "👁️",
        "👁️‍🗨️",
        "👃",
        "👂",
        "🦻",
        "🧠",
        "🦷",
        "🦴",
        "👅",
        "👄",
      ],
    ],
    [
      "Hands",
      [
        "👍",
        "👎",
        "👊",
        "✊",
        "🤛",
        "🤜",
        "👏",
        "🙌",
        "🫶",
        "👐",
        "🤲",
        "🤝",
        "🙏",
        "✌️",
        "🤞",
        "🫰",
        "🤟",
        "🤘",
        "🤙",
        "👋",
        "🖐️",
        "✋",
        "🖖",
        "👌",
        "🤌",
        "🤏",
        "☝️",
        "👆",
        "👇",
        "👈",
        "👉",
        "💪",
        "🫵",
        "🫱",
        "🫲",
        "🫳",
        "🫴",
        "🦾",
        "🤚",
        "✍️",
      ],
    ],
    [
      "Hearts",
      [
        "❤️",
        "🧡",
        "💛",
        "💚",
        "💙",
        "💜",
        "🖤",
        "🤍",
        "🤎",
        "❤️‍🔥",
        "❤️‍🩹",
        "💔",
        "❣️",
        "💕",
        "💞",
        "💓",
        "💗",
        "💖",
        "💝",
        "💘",
        "💟",
        "♥️",
        "🩷",
        "🩵",
        "🩶",
      ],
    ],
    [
      "People",
      [
        "👶",
        "👦",
        "👧",
        "👨",
        "👩",
        "🧑",
        "👴",
        "👵",
        "🧓",
        "👮",
        "🕵️",
        "💂",
        "🥷",
        "👷",
        "🤴",
        "👸",
        "🧙",
        "🧚",
        "🧛",
        "🧜",
        "🧝",
        "🧞",
        "🧟",
        "🦸",
        "🦹",
        "🏃",
        "💃",
        "🕺",
        "🧖",
        "🧗",
        "🏄",
        "🚴",
        "🤸",
        "🏊",
      ],
    ],
    [
      "Animals",
      [
        "🐶",
        "🐱",
        "🐭",
        "🐹",
        "🐰",
        "🦊",
        "🐻",
        "🐼",
        "🐻‍❄️",
        "🐨",
        "🐯",
        "🦁",
        "🐮",
        "🐷",
        "🐸",
        "🐵",
        "🙈",
        "🙉",
        "🙊",
        "🐔",
        "🐧",
        "🐦",
        "🐤",
        "🦆",
        "🦅",
        "🦉",
        "🐺",
        "🐗",
        "🐴",
        "🦄",
        "🐝",
        "🪱",
        "🐛",
        "🦋",
        "🐌",
        "🐞",
        "🐜",
        "🪰",
        "🕷️",
        "🦂",
        "🐢",
        "🐍",
        "🦎",
        "🐙",
        "🦑",
        "🦐",
        "🦀",
        "🐡",
        "🐠",
        "🐟",
        "🐬",
        "🐳",
        "🐋",
        "🦈",
        "🐊",
        "🐅",
        "🐆",
        "🦓",
        "🦍",
        "🦧",
        "🐘",
        "🦛",
        "🦏",
        "🐪",
        "🐫",
        "🦒",
        "🦘",
        "🦬",
        "🐃",
        "🐂",
        "🐄",
        "🐎",
        "🐖",
        "🐏",
        "🐑",
        "🦙",
        "🐐",
        "🦌",
        "🐕",
        "🐈",
        "🐓",
        "🦃",
        "🦤",
        "🦚",
        "🦜",
        "🦢",
        "🦩",
        "🕊️",
        "🐇",
        "🦝",
        "🦨",
        "🦡",
        "🦫",
        "🦦",
        "🦥",
        "🐁",
        "🐀",
        "🐿️",
        "🦔",
      ],
    ],
    [
      "Nature",
      [
        "🌱",
        "🌿",
        "🍀",
        "🍁",
        "🍂",
        "🍃",
        "🌵",
        "🎄",
        "🌲",
        "🌳",
        "🌴",
        "🪵",
        "🌾",
        "🌺",
        "🌻",
        "🌹",
        "🥀",
        "🌷",
        "🌼",
        "💐",
        "🍄",
        "🪨",
        "🪸",
        "🌸",
        "🪻",
        "🪷",
        "☀️",
        "🌙",
        "⭐",
        "🌟",
        "✨",
        "💫",
        "🌈",
        "☁️",
        "⛅",
        "🌤️",
        "🌥️",
        "🌦️",
        "🌧️",
        "⛈️",
        "🌩️",
        "🌪️",
        "🌫️",
        "❄️",
        "☃️",
        "⛄",
        "🔥",
        "💧",
        "🌊",
        "💥",
        "💨",
        "🌀",
      ],
    ],
    [
      "Food",
      [
        "🍎",
        "🍐",
        "🍊",
        "🍋",
        "🍌",
        "🍉",
        "🍇",
        "🍓",
        "🫐",
        "🍈",
        "🍒",
        "🍑",
        "🥭",
        "🍍",
        "🥥",
        "🥝",
        "🍅",
        "🥑",
        "🍆",
        "🌶️",
        "🫑",
        "🥒",
        "🥬",
        "🥦",
        "🧄",
        "🧅",
        "🥔",
        "🍠",
        "🥐",
        "🍞",
        "🥖",
        "🥨",
        "🧀",
        "🥚",
        "🍳",
        "🥞",
        "🧇",
        "🥓",
        "🥩",
        "🍗",
        "🍖",
        "🌭",
        "🍔",
        "🍟",
        "🍕",
        "🫓",
        "🥪",
        "🌮",
        "🌯",
        "🫔",
        "🥙",
        "🧆",
        "🥗",
        "🍝",
        "🍜",
        "🍲",
        "🍛",
        "🍣",
        "🍱",
        "🥟",
        "🍤",
        "🍙",
        "🍚",
        "🍘",
        "🍥",
        "🥮",
        "🍡",
        "🍧",
        "🍨",
        "🍦",
        "🥧",
        "🧁",
        "🍰",
        "🎂",
        "🍮",
        "🍭",
        "🍬",
        "🍫",
        "🍿",
        "🍩",
        "🍪",
        "🥜",
        "🌰",
        "🍯",
        "☕",
        "🍵",
        "🫖",
        "🧃",
        "🥤",
        "🍶",
        "🍺",
        "🍻",
        "🥂",
        "🍷",
        "🥃",
        "🍸",
        "🍹",
        "🧉",
        "🫗",
        "🧊",
      ],
    ],
    [
      "Travel",
      [
        "🚗",
        "🚕",
        "🚙",
        "🏎️",
        "🚓",
        "🚑",
        "🚒",
        "🚐",
        "🛻",
        "🚚",
        "🚛",
        "🚜",
        "🛵",
        "🏍️",
        "🚲",
        "🛴",
        "🚨",
        "🚔",
        "🚍",
        "🚘",
        "🚖",
        "🛞",
        "🚡",
        "🚠",
        "🚟",
        "🚃",
        "🚋",
        "🚞",
        "🚝",
        "🚄",
        "🚅",
        "🚈",
        "🚂",
        "🚆",
        "🛩️",
        "✈️",
        "🛫",
        "🛬",
        "🪂",
        "💺",
        "🚀",
        "🛸",
        "🚁",
        "🛶",
        "⛵",
        "🚤",
        "🛥️",
        "🛳️",
        "⛴️",
        "🚢",
        "⚓",
        "🏠",
        "🏡",
        "🏢",
        "🏣",
        "🏤",
        "🏥",
        "🏦",
        "🏨",
        "🏩",
        "🏪",
        "🏫",
        "🏬",
        "🏭",
        "🏯",
        "🏰",
        "💒",
        "🗼",
        "🗽",
        "⛪",
        "🕌",
        "🛕",
        "🕍",
        "⛩️",
        "🕋",
        "⛲",
        "⛺",
        "🏕️",
        "🌁",
        "🌃",
        "🌆",
        "🌇",
        "🌉",
        "🗻",
        "🏔️",
        "🌋",
        "🗾",
      ],
    ],
    [
      "Objects",
      [
        "⌚",
        "📱",
        "💻",
        "⌨️",
        "🖥️",
        "🖨️",
        "🖱️",
        "🖲️",
        "🕹️",
        "🗜️",
        "💽",
        "💾",
        "💿",
        "📀",
        "📼",
        "📷",
        "📸",
        "📹",
        "🎥",
        "📽️",
        "🎞️",
        "📞",
        "☎️",
        "📟",
        "📠",
        "📺",
        "📻",
        "🎙️",
        "🎚️",
        "🎛️",
        "🧭",
        "⏱️",
        "⏲️",
        "⏰",
        "🕰️",
        "⌛",
        "⏳",
        "📡",
        "🔋",
        "🔌",
        "💡",
        "🔦",
        "🕯️",
        "🧯",
        "🛢️",
        "💸",
        "💵",
        "💴",
        "💶",
        "💷",
        "🪙",
        "💰",
        "💳",
        "🧾",
        "✉️",
        "📧",
        "📨",
        "📩",
        "📦",
        "📫",
        "📪",
        "📬",
        "📭",
        "📮",
        "📝",
        "📁",
        "📂",
        "📋",
        "📊",
        "📈",
        "📉",
        "📄",
        "📃",
        "📕",
        "📗",
        "📘",
        "📙",
        "📚",
        "📖",
        "📓",
        "📒",
        "📑",
        "🔖",
        "🗒️",
        "📔",
        "🔑",
        "🗝️",
        "🔒",
        "🔓",
        "🔏",
        "🔐",
        "🛠️",
        "🔧",
        "🔩",
        "⚙️",
        "🧰",
        "🪛",
        "🪚",
        "🔨",
        "⛏️",
        "⚒️",
        "🪓",
        "🗡️",
        "⚔️",
        "💣",
        "🪃",
        "🏹",
        "🛡️",
        "🪤",
        "🔗",
        "⛓️",
        "🪝",
        "🧲",
        "🪜",
        "📌",
        "📎",
        "🖇️",
        "🏷️",
        "🗑️",
        "🧪",
        "🔬",
        "🔭",
        "📐",
        "📏",
        "🧬",
      ],
    ],
    [
      "Activities",
      [
        "⚽",
        "🏀",
        "🏈",
        "⚾",
        "🥎",
        "🎾",
        "🏐",
        "🏉",
        "🥏",
        "🎱",
        "🪀",
        "🏓",
        "🏸",
        "🏒",
        "🏑",
        "🥍",
        "🏏",
        "🪃",
        "🥅",
        "⛳",
        "🪁",
        "🏹",
        "🎣",
        "🤿",
        "🥊",
        "🥋",
        "🎽",
        "🛹",
        "🛼",
        "🛷",
        "⛸️",
        "🥌",
        "🎿",
        "⛷️",
        "🏂",
        "🪂",
        "🏋️",
        "🤺",
        "🏇",
        "🎮",
        "🕹️",
        "🎲",
        "🧩",
        "♟️",
        "🎰",
        "🎳",
        "🎯",
        "🎪",
        "🎭",
        "🎨",
        "🧵",
        "🧶",
        "🪡",
        "🎼",
        "🎵",
        "🎶",
        "🎹",
        "🥁",
        "🪘",
        "🎷",
        "🎺",
        "🪗",
        "🎸",
        "🪕",
        "🎻",
        "🎬",
        "🎤",
      ],
    ],
    [
      "Symbols",
      [
        "✅",
        "❌",
        "❓",
        "❗",
        "‼️",
        "⁉️",
        "⚠️",
        "🚫",
        "♻️",
        "✳️",
        "❇️",
        "🔆",
        "🔅",
        "⚜️",
        "🔱",
        "〽️",
        "🔰",
        "☑️",
        "✔️",
        "❎",
        "➕",
        "➖",
        "➗",
        "✖️",
        "💲",
        "💱",
        "©️",
        "®️",
        "™️",
        "🔟",
        "🔢",
        "#️⃣",
        "*️⃣",
        "0️⃣",
        "1️⃣",
        "2️⃣",
        "3️⃣",
        "4️⃣",
        "5️⃣",
        "6️⃣",
        "7️⃣",
        "8️⃣",
        "9️⃣",
        "🔠",
        "🔡",
        "🔤",
        "🅰️",
        "🆎",
        "🅱️",
        "🆑",
        "🆒",
        "🆓",
        "ℹ️",
        "🆔",
        "Ⓜ️",
        "🆕",
        "🆖",
        "🅾️",
        "🆗",
        "🅿️",
        "🆘",
        "🆙",
        "🆚",
        "🔴",
        "🟠",
        "🟡",
        "🟢",
        "🔵",
        "🟣",
        "🟤",
        "⚫",
        "⚪",
        "🟥",
        "🟧",
        "🟨",
        "🟩",
        "🟦",
        "🟪",
        "🟫",
        "⬛",
        "⬜",
        "◼️",
        "◻️",
        "🔶",
        "🔷",
        "🔸",
        "🔹",
        "🔺",
        "🔻",
        "💠",
        "🔘",
        "🔳",
        "🔲",
        "💬",
        "💭",
        "🗯️",
        "💢",
        "🔔",
        "🔕",
        "📣",
        "📢",
        "🏁",
        "🚩",
        "🎌",
        "🏴",
        "🏳️",
        "🏳️‍🌈",
        "🏳️‍⚧️",
        "🏴‍☠️",
      ],
    ],
    [
      "Flags",
      [
        "🇺🇸",
        "🇬🇧",
        "🇩🇪",
        "🇫🇷",
        "🇪🇸",
        "🇮🇹",
        "🇯🇵",
        "🇰🇷",
        "🇨🇳",
        "🇧🇷",
        "🇮🇳",
        "🇷🇺",
        "🇨🇦",
        "🇦🇺",
        "🇲🇽",
        "🇦🇷",
        "🇳🇱",
        "🇧🇪",
        "🇨🇭",
        "🇦🇹",
        "🇸🇪",
        "🇳🇴",
        "🇩🇰",
        "🇫🇮",
        "🇵🇱",
        "🇺🇦",
        "🇹🇷",
        "🇸🇦",
        "🇦🇪",
        "🇮🇱",
        "🇪🇬",
        "🇿🇦",
        "🇳🇬",
        "🇰🇪",
        "🇹🇭",
        "🇻🇳",
        "🇮🇩",
        "🇵🇭",
        "🇲🇾",
        "🇸🇬",
        "🇳🇿",
        "🇨🇴",
        "🇨🇱",
        "🇵🇪",
        "🇵🇹",
        "🇬🇷",
        "🇮🇪",
        "🇭🇺",
        "🇨🇿",
        "🇷🇴",
        "🇧🇬",
      ],
    ],
  ];

  const KEYWORDS: Record<string, string[]> = {
    smile: ["😀", "😃", "😄", "😁", "😊", "😌"],
    grin: ["😀", "😃", "😄", "😁"],
    laugh: ["😂", "🤣"],
    joy: ["😂"],
    happy: ["😀", "😃", "😄", "😊", "🥳"],
    love: ["😍", "🥰", "😘", "❤️", "💕", "💖", "💗", "💝", "💘"],
    kiss: ["😘", "😗"],
    yum: ["😋"],
    money: ["🤑", "💰", "💵", "💸", "💳", "🪙"],
    hug: ["🤗", "🫶"],
    shush: ["🤫"],
    think: ["🤔"],
    salute: ["🫡"],
    neutral: ["😐", "😑", "😶"],
    smirk: ["😏"],
    unamused: ["😒"],
    "eye roll": ["🙄"],
    grimace: ["😬"],
    lie: ["🤥"],
    sad: ["😔", "😢", "😭", "😥", "🥺"],
    sleep: ["😪", "😴"],
    drool: ["🤤"],
    sick: ["😷", "🤒", "🤕", "🤢", "🤮"],
    dizzy: ["🥴", "😵"],
    "mind blown": ["🤯"],
    party: ["🥳", "🎉", "🎊"],
    disguise: ["🥸"],
    cool: ["😎"],
    star: ["🤩", "⭐", "🌟", "✨"],
    pleading: ["🥹", "🥺"],
    scream: ["😱"],
    fear: ["😨", "😰"],
    cry: ["😢", "😭"],
    angry: ["😤", "😡", "🤬"],
    skull: ["💀", "☠️"],
    ghost: ["👻"],
    alien: ["👽"],
    robot: ["🤖"],
    poop: ["💩"],
    devil: ["😈", "👹"],
    melt: ["🫠"],
    blush: ["😳"],
    peek: ["🫣"],
    oops: ["🫢"],
    eyes: ["👀", "👁️", "👁️‍🗨️"],
    look: ["👀", "👁️"],
    watch: ["👀"],
    see: ["👀", "👁️"],
    ear: ["👂", "🦻"],
    nose: ["👃"],
    brain: ["🧠"],
    tongue: ["😛", "😜", "🤪", "😝", "👅"],
    mouth: ["👄"],
    tooth: ["🦷"],
    bone: ["🦴"],
    "thumbs up": ["👍"],
    "thumbs down": ["👎"],
    fist: ["👊", "✊", "🤛", "🤜"],
    clap: ["👏"],
    raise: ["🙌"],
    "heart hands": ["🫶"],
    pray: ["🙏"],
    peace: ["✌️"],
    "cross fingers": ["🤞"],
    rock: ["🤘"],
    call: ["🤙"],
    wave: ["👋"],
    hand: ["🖐️", "✋", "🤚"],
    ok: ["👌"],
    pinch: ["🤌", "🤏"],
    point: ["☝️", "👆", "👇", "👈", "👉", "🫵"],
    strong: ["💪"],
    write: ["✍️"],
    heart: [
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "🤎",
      "♥️",
      "🩷",
      "🩵",
      "🩶",
    ],
    "fire heart": ["❤️‍🔥"],
    "broken heart": ["💔"],
    "sparkle heart": ["💖"],
    "growing heart": ["💗"],
    "beating heart": ["💓"],
    "revolving hearts": ["💞"],
    "two hearts": ["💕"],
    baby: ["👶"],
    boy: ["👦"],
    girl: ["👧"],
    man: ["👨"],
    woman: ["👩"],
    person: ["🧑"],
    old: ["👴", "👵", "🧓"],
    police: ["👮"],
    detective: ["🕵️"],
    guard: ["💂"],
    ninja: ["🥷"],
    construction: ["👷"],
    prince: ["🤴"],
    princess: ["👸"],
    wizard: ["🧙"],
    fairy: ["🧚"],
    vampire: ["🧛"],
    mermaid: ["🧜"],
    elf: ["🧝"],
    zombie: ["🧟"],
    superhero: ["🦸"],
    villain: ["🦹"],
    run: ["🏃"],
    dance: ["💃", "🕺"],
    climb: ["🧗"],
    surf: ["🏄"],
    bike: ["🚴", "🚲"],
    swim: ["🏊"],
    dog: ["🐶", "🐕"],
    cat: ["🐱", "🐈"],
    mouse: ["🐭", "🐁"],
    hamster: ["🐹"],
    rabbit: ["🐰", "🐇"],
    fox: ["🦊"],
    bear: ["🐻", "🐻‍❄️"],
    panda: ["🐼"],
    koala: ["🐨"],
    tiger: ["🐯", "🐅"],
    lion: ["🦁"],
    cow: ["🐮", "🐄"],
    pig: ["🐷", "🐖"],
    frog: ["🐸"],
    monkey: ["🐵", "🙈", "🙉", "🙊"],
    chicken: ["🐔", "🐓"],
    penguin: ["🐧"],
    bird: ["🐦", "🕊️"],
    duck: ["🦆"],
    eagle: ["🦅"],
    owl: ["🦉"],
    wolf: ["🐺"],
    horse: ["🐴", "🐎"],
    unicorn: ["🦄"],
    bee: ["🐝"],
    bug: ["🐛", "🐞", "🐜"],
    butterfly: ["🦋"],
    snail: ["🐌"],
    spider: ["🕷️"],
    turtle: ["🐢"],
    snake: ["🐍"],
    octopus: ["🐙"],
    shark: ["🦈"],
    whale: ["🐳", "🐋"],
    dolphin: ["🐬"],
    fish: ["🐠", "🐟", "🐡"],
    crab: ["🦀"],
    shrimp: ["🦐"],
    crocodile: ["🐊"],
    elephant: ["🐘"],
    giraffe: ["🦒"],
    gorilla: ["🦍"],
    deer: ["🦌"],
    hedgehog: ["🦔"],
    squirrel: ["🐿️"],
    raccoon: ["🦝"],
    sloth: ["🦥"],
    otter: ["🦦"],
    peacock: ["🦚"],
    parrot: ["🦜"],
    swan: ["🦢"],
    flamingo: ["🦩"],
    dodo: ["🦤"],
    plant: ["🌱", "🌿"],
    clover: ["🍀"],
    leaf: ["🍁", "🍂", "🍃"],
    cactus: ["🌵"],
    tree: ["🌲", "🌳", "🌴", "🎄"],
    flower: ["🌺", "🌻", "🌹", "🌷", "🌼", "💐", "🌸", "🪻", "🪷"],
    rose: ["🌹"],
    "cherry blossom": ["🌸"],
    sunflower: ["🌻"],
    mushroom: ["🍄"],
    sun: ["☀️"],
    moon: ["🌙"],
    rainbow: ["🌈"],
    cloud: ["☁️", "⛅"],
    rain: ["🌧️"],
    snow: ["❄️", "☃️", "⛄"],
    fire: ["🔥"],
    water: ["💧", "🌊"],
    lightning: ["⚡", "🌩️"],
    tornado: ["🌪️"],
    wind: ["💨"],
    sparkle: ["✨", "💫"],
    boom: ["💥"],
    explosion: ["💥"],
    apple: ["🍎"],
    orange: ["🍊"],
    lemon: ["🍋"],
    banana: ["🍌"],
    watermelon: ["🍉"],
    grape: ["🍇"],
    strawberry: ["🍓"],
    blueberry: ["🫐"],
    peach: ["🍑"],
    mango: ["🥭"],
    pineapple: ["🍍"],
    avocado: ["🥑"],
    tomato: ["🍅"],
    pepper: ["🌶️"],
    bread: ["🍞"],
    cheese: ["🧀"],
    egg: ["🥚"],
    bacon: ["🥓"],
    meat: ["🥩"],
    pizza: ["🍕"],
    burger: ["🍔"],
    fries: ["🍟"],
    hotdog: ["🌭"],
    taco: ["🌮"],
    burrito: ["🌯"],
    sushi: ["🍣"],
    rice: ["🍚"],
    noodles: ["🍜"],
    pasta: ["🍝"],
    cake: ["🎂", "🍰"],
    cupcake: ["🧁"],
    pie: ["🥧"],
    candy: ["🍬"],
    chocolate: ["🍫"],
    lollipop: ["🍭"],
    donut: ["🍩"],
    cookie: ["🍪"],
    popcorn: ["🍿"],
    coffee: ["☕"],
    tea: ["🍵"],
    beer: ["🍺", "🍻"],
    wine: ["🍷"],
    cocktail: ["🍸", "🍹"],
    "ice cream": ["🍦", "🍧", "🍨"],
    car: ["🚗", "🚕", "🚙"],
    race: ["🏎️"],
    ambulance: ["🚑"],
    "fire truck": ["🚒"],
    truck: ["🚚", "🚛", "🛻"],
    motorcycle: ["🏍️"],
    bicycle: ["🚲"],
    bus: ["🚍"],
    train: ["🚃", "🚂", "🚄", "🚅", "🚆", "🚝", "🚞"],
    plane: ["✈️", "🛩️", "🛫", "🛬"],
    rocket: ["🚀"],
    ufo: ["🛸"],
    helicopter: ["🚁"],
    boat: ["⛵", "🚤", "🛥️", "🛶"],
    ship: ["🛳️", "🚢"],
    house: ["🏠", "🏡"],
    building: ["🏢"],
    hospital: ["🏥"],
    school: ["🏫"],
    factory: ["🏭"],
    castle: ["🏰"],
    church: ["⛪"],
    mountain: ["🗻", "🏔️"],
    volcano: ["🌋"],
    tent: ["⛺"],
    camping: ["🏕️"],
    city: ["🌃", "🌆"],
    book: ["📕", "📗", "📘", "📙", "📚", "📖", "📓", "📒", "📔"],
    books: ["📚"],
    notebook: ["📓", "📒", "📔"],
    bookmark: ["🔖"],
    read: ["📖", "📚"],
    study: ["📖", "📚"],
    phone: ["📱", "📞", "☎️"],
    computer: ["💻", "🖥️"],
    keyboard: ["⌨️"],
    joystick: ["🕹️"],
    disk: ["💽", "💾", "💿"],
    camera: ["📷", "📸"],
    video: ["📹", "🎥"],
    tv: ["📺"],
    radio: ["📻"],
    mic: ["🎙️", "🎤"],
    clock: ["⏰", "🕰️", "⏱️", "⏲️"],
    hourglass: ["⌛", "⏳"],
    battery: ["🔋"],
    bulb: ["💡"],
    light: ["💡", "🔦"],
    candle: ["🕯️"],
    "money bag": ["💰"],
    "credit card": ["💳"],
    mail: ["✉️", "📧", "📨", "📩"],
    package: ["📦"],
    memo: ["📝"],
    folder: ["📁", "📂"],
    clipboard: ["📋"],
    chart: ["📊", "📈", "📉"],
    key: ["🔑", "🗝️"],
    lock: ["🔒", "🔐"],
    unlock: ["🔓"],
    tool: ["🛠️", "🧰"],
    wrench: ["🔧"],
    gear: ["⚙️"],
    hammer: ["🔨"],
    sword: ["🗡️", "⚔️"],
    bomb: ["💣"],
    shield: ["🛡️"],
    link: ["🔗"],
    magnet: ["🧲"],
    pin: ["📌"],
    paperclip: ["📎", "🖇️"],
    tag: ["🏷️"],
    trash: ["🗑️"],
    science: ["🧪", "🔬", "🔭", "🧬"],
    microscope: ["🔬"],
    telescope: ["🔭"],
    dna: ["🧬"],
    soccer: ["⚽"],
    basketball: ["🏀"],
    football: ["🏈"],
    baseball: ["⚾"],
    tennis: ["🎾"],
    volleyball: ["🏐"],
    golf: ["⛳"],
    fishing: ["🎣"],
    boxing: ["🥊"],
    skateboard: ["🛹"],
    ski: ["🎿", "⛷️"],
    snowboard: ["🏂"],
    game: ["🎮", "🕹️"],
    dice: ["🎲"],
    puzzle: ["🧩"],
    chess: ["♟️"],
    target: ["🎯"],
    art: ["🎨"],
    paint: ["🎨"],
    music: ["🎵", "🎶", "🎼"],
    piano: ["🎹"],
    guitar: ["🎸"],
    drum: ["🥁"],
    trumpet: ["🎺"],
    violin: ["🎻"],
    movie: ["🎬"],
    circus: ["🎪"],
    theater: ["🎭"],
    check: ["✅", "☑️", "✔️"],
    "cross mark": ["❌", "❎"],
    question: ["❓"],
    exclamation: ["❗", "‼️", "⁉️"],
    warning: ["⚠️"],
    no: ["🚫"],
    recycle: ["♻️"],
    plus: ["➕"],
    minus: ["➖"],
    red: ["🔴", "🟥"],
    yellow: ["🟡", "🟨"],
    green: ["🟢", "🟩"],
    blue: ["🔵", "🟦"],
    purple: ["🟣", "🟪"],
    black: ["⚫", "⬛"],
    white: ["⚪", "⬜"],
    speech: ["💬", "💭", "🗯️"],
    bell: ["🔔"],
    megaphone: ["📣", "📢"],
    flag: ["🏁", "🚩"],
  };

  type PickerTab = "all" | "apps" | "emojis" | "stickers";
  type PickerContentKind = Exclude<PickerTab, "all">;

  const PICKER_TABS: { id: PickerTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "apps", label: "Apps" },
    { id: "emojis", label: "Emojis" },
    { id: "stickers", label: "Stickers" },
  ];

  const searchIndex: {
    token: string;
    terms: string;
    kind: PickerContentKind;
  }[] = [];
  for (const [term, emojis] of Object.entries(KEYWORDS)) {
    for (const e of emojis) {
      searchIndex.push({ token: e, terms: term, kind: "emojis" });
    }
  }
  // App icons searchable by name, label, and keywords.
  for (const icon of APP_ICONS) {
    const token = `${APP_ICON_TOKEN_PREFIX}${icon.name}`;
    const terms = [icon.name, icon.label, ...(icon.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    searchIndex.push({ token, terms, kind: "apps" });
  }
  for (const pack of STICKER_PACKS) {
    for (const sticker of pack.stickers) {
      const terms = [
        pack.id,
        pack.label,
        sticker.sheet.id,
        sticker.sheet.name,
        sticker.sheet.label,
        sticker.label,
        "sticker",
      ]
        .join(" ")
        .toLowerCase();
      searchIndex.push({
        token: sticker.token,
        terms,
        kind: "stickers",
      });
    }
  }

  let query = "";
  let activeTab: PickerTab = "all";
  let inputEl: HTMLInputElement;

  $: smileyEmojiGroup = EMOJIS.find(([category]) => category === "Smileys");
  $: otherEmojiGroups = EMOJIS.filter(([category]) => category !== "Smileys");
  $: jungleStickerPacks = STICKER_PACKS.filter(isJunglePack);
  $: otherStickerPacks = STICKER_PACKS.filter((pack) => !isJunglePack(pack));
  $: lowerQuery = query.trim().toLowerCase();
  $: searchResults =
    lowerQuery.length > 0 ? getSearchResults(lowerQuery, activeTab) : null;

  function isJunglePack(pack: StickerPack): boolean {
    return pack.id.toLowerCase() === "jungle";
  }

  function tabMatchesKind(tab: PickerTab, kind: PickerContentKind): boolean {
    return tab === "all" || tab === kind;
  }

  function getSearchResults(q: string, tab: PickerTab): string[] {
    const seen = new Set<string>();
    const results: string[] = [];
    for (const entry of searchIndex) {
      if (
        tabMatchesKind(tab, entry.kind) &&
        entry.terms.includes(q) &&
        !seen.has(entry.token)
      ) {
        seen.add(entry.token);
        results.push(entry.token);
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

{#snippet appGroup()}
  {#if APP_ICONS.length > 0}
    <div class="emoji-category">
      <span class="emoji-category-label">Apps</span>
      <div class="emoji-grid">
        {#each APP_ICONS as icon (icon.name)}
          <button
            class="emoji-cell emoji-cell-app"
            type="button"
            on:click={() => onPick(`${APP_ICON_TOKEN_PREFIX}${icon.name}`)}
            title={icon.label}
          >
            <img
              class="emoji-app-icon"
              src={appIconUrl(icon.name)}
              alt={icon.label}
            />
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet emojiGroup(category: string, emojis: string[])}
  <div class="emoji-category">
    <span class="emoji-category-label">{category}</span>
    <div class="emoji-grid">
      {#each emojis as emoji}
        <button
          class="emoji-cell"
          type="button"
          on:click={() => onPick(emoji)}
          title={emoji}>{emoji}</button
        >
      {/each}
    </div>
  </div>
{/snippet}

{#snippet stickerPackGroup(pack: StickerPack)}
  <div class="emoji-category">
    <span class="emoji-category-label">{pack.label}</span>
    <div class="emoji-grid">
      {#each pack.stickers as sticker (sticker.token)}
        <button
          class="emoji-cell emoji-cell-sticker"
          type="button"
          on:click={() => onPick(sticker.token)}
          title={sticker.label}
        >
          <span
            class="emoji-sticker-preview"
            aria-label={sticker.label}
            style={stickerPreviewStyle(sticker)}
          ></span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

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
    <div class="emoji-picker-tabs" aria-label="Sticker categories">
      {#each PICKER_TABS as tab (tab.id)}
        <button
          class="emoji-picker-tab"
          class:emoji-picker-tab-active={activeTab === tab.id}
          type="button"
          aria-pressed={activeTab === tab.id}
          on:click={() => (activeTab = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
    {#if searchResults}
      {#if searchResults.length > 0}
        <div class="emoji-grid">
          {#each searchResults as token}
            {@const appName = token.startsWith(APP_ICON_TOKEN_PREFIX)
              ? token.slice(APP_ICON_TOKEN_PREFIX.length)
              : null}
            {@const sticker = token.startsWith(STICKER_TOKEN_PREFIX)
              ? stickerFromToken(token)
              : null}
            <button
              class="emoji-cell"
              class:emoji-cell-app={appName !== null}
              class:emoji-cell-sticker={sticker !== null}
              type="button"
              on:click={() => onPick(token)}
              title={sticker?.label ?? appName ?? token}
            >
              {#if sticker !== null}
                <span
                  class="emoji-sticker-preview"
                  aria-label={sticker.label}
                  style={stickerPreviewStyle(sticker)}
                ></span>
              {:else if appName !== null}
                <img
                  class="emoji-app-icon"
                  src={appIconUrl(appName)}
                  alt={appName}
                />
              {:else}
                {token}
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="emoji-no-results">No matches</div>
      {/if}
    {:else}
      {#if activeTab === "all"}
        {@render appGroup()}
        {#if smileyEmojiGroup}
          {@render emojiGroup(smileyEmojiGroup[0], smileyEmojiGroup[1])}
        {/if}
        {#each jungleStickerPacks as pack (pack.id)}
          {@render stickerPackGroup(pack)}
        {/each}
        {#each otherEmojiGroups as [category, emojis]}
          {@render emojiGroup(category, emojis)}
        {/each}
        {#each otherStickerPacks as pack (pack.id)}
          {@render stickerPackGroup(pack)}
        {/each}
      {:else if activeTab === "apps"}
        {@render appGroup()}
      {:else if activeTab === "emojis"}
        {#each EMOJIS as [category, emojis]}
          {@render emojiGroup(category, emojis)}
        {/each}
      {:else if activeTab === "stickers"}
        {#each STICKER_PACKS as pack (pack.id)}
          {@render stickerPackGroup(pack)}
        {/each}
      {/if}
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
    box-sizing: border-box;
    width: 100%;
    padding: 0 12px 10px;
    max-height: 420px;
    overflow-y: scroll;
    overflow-x: hidden;
    scrollbar-gutter: stable both-edges;
  }
  .emoji-picker-tabs {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    gap: 4px;
    padding: 8px 0 9px;
    background: var(--popover-bg, #191919);
  }
  .emoji-picker-tab {
    all: unset;
    box-sizing: border-box;
    flex: 1 1 0;
    min-width: 0;
    height: 23px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--text-muted, #888);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .emoji-picker-tab:hover {
    color: var(--text, #eee);
    background: rgba(255, 255, 255, 0.08);
  }
  .emoji-picker-tab-active {
    color: var(--text, #eee);
    background: rgba(255, 255, 255, 0.13);
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
    justify-self: center;
    width: 100%;
    max-width: 36px;
    aspect-ratio: 1;
    height: auto;
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
  .emoji-app-icon {
    width: 26px;
    height: 26px;
    object-fit: contain;
    pointer-events: none;
  }
  .emoji-sticker-preview {
    width: 30px;
    height: 30px;
    display: block;
    border-radius: 4px;
    pointer-events: none;
  }
  .emoji-no-results {
    padding: 16px 0;
    text-align: center;
    font-size: 12px;
    color: var(--text-muted, #888);
  }
</style>
