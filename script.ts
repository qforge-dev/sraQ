import { intentPrompt, schema } from "./intent-prompt";
import { OpenAI } from "openai";
import Together from "together-ai";
import { z } from "zod";

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });
const together = new Together({
  apiKey: process.env.TOGETHER_API_KEY,
});

const completion = await together.chat.completions
  .create({
    model: "dk_4ee7/gpt-oss-20b-d1b0cf14-7b07d775",
    messages: [
      { role: "system", content: intentPrompt },
      { role: "user", content: "whats the weather sf" },
    ],
    response_format: {
      type: "json_object",
    },
  })
  .then((completion) => {
    console.log(completion.choices[0]?.message?.content);
  })
  .catch((error) => {
    console.error(error);
  });
