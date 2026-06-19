c = open('/home/ubuntu/besinsky-bot/src/whatsapp.js', 'rb').read()
idx = c.find(b"done');\r\n")
print(repr(c[idx:idx+150]))
