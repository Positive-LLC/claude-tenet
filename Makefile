BINARY = tenet
INSTALL_DIR = $(HOME)/.local/bin

.PHONY: install clean

install:
	deno compile --allow-all --output $(BINARY) src/main.ts
	mkdir -p $(INSTALL_DIR)
	mv $(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "Installed $(INSTALL_DIR)/$(BINARY)"

clean:
	rm -f $(INSTALL_DIR)/$(BINARY)
