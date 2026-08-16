// mediaParser.js — parses file/media attachments for different AI providers

function parseMediaPayload(message, fileData, fileName, fileType, isTextFile) {
    let finalMessage = message || '';
    let geminiPayload = finalMessage;
    let zhipuPayload  = finalMessage;
    let nvidiaPayload = finalMessage;   // NVIDIA NIM only supports text
    let zhipuModelOverride = null;

    if (fileData) {
        if (isTextFile) {
            // Text/CSV/JSON/Markdown — append as plain text to all providers
            const fileContent = `\n\n--- Attached File: ${fileName || 'document'} ---\n${fileData}\n--- End of File ---\n`;
            finalMessage  += fileContent;
            geminiPayload  = finalMessage;
            zhipuPayload   = finalMessage;
            nvidiaPayload  = finalMessage;
        } else {
            // Binary (image / PDF)

            // Gemini: inline data parts
            geminiPayload = [
                { text: finalMessage },
                {
                    inlineData: {
                        data: fileData,
                        mimeType: fileType || 'application/octet-stream'
                    }
                }
            ];

            // Zhipu: vision model for images
            if (fileType && fileType.startsWith('image/')) {
                zhipuModelOverride = 'glm-4v';
                const dataUrl = `data:${fileType};base64,${fileData}`;
                zhipuPayload = [
                    { type: 'text',      text: finalMessage },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ];
            } else {
                // PDF / other binary — tell the model a file was attached but can't be processed
                finalMessage  += `\n\n[System Note: User attached a ${fileType} file named "${fileName}", but this model cannot process binary files directly.]`;
                zhipuPayload   = finalMessage;
                nvidiaPayload  = finalMessage;
            }

            // NVIDIA NIM (text-only): inform model about the image if it was one
            if (fileType && fileType.startsWith('image/')) {
                nvidiaPayload = `${finalMessage}\n\n[Note: User attached an image "${fileName}" — describe what you think it might be based on context, as you cannot see images directly.]`;
            }
        }
    }

    return {
        geminiPayload,
        zhipuPayload,
        nvidiaPayload,
        zhipuModelOverride,
        finalMessage   // plain-text fallback
    };
}

module.exports = { parseMediaPayload };
